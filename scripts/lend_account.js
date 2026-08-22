// Lend a Steam account to someone for a while, then rotate the password when it
// comes back. Steam has no API for changing a password (it is a Guard-confirmed
// web flow at store.steampowered.com/account/), so THAT step is manual — this
// script handles everything around it:
//
//   check   snapshot the account before you hand it over (wallet, level, points,
//           friends, licenses, pending/sent gifts, Steam Guard type)
//   lend    record the loan + snapshot, print the hand-over checklist and due time
//   list    show open loans and what is overdue
//   return  after you have changed the password on the web: verify the OLD
//           password is dead, cache a fresh refresh token with the new one,
//           optionally rewrite the password in a credentials file, and diff the
//           account state against the pre-loan snapshot
//
// Usage:
//
//   node lend_account.js check  <account> [--password=<pw>]
//   node lend_account.js lend   <account> --to="friend" [--days=1] [--note="..."]
//   node lend_account.js list   [--all]
//   node lend_account.js return <account> [--new-password=<pw>] [--old-password=<pw>]
//                                         [--update-file=<path>] [--loan-id=<n>]
//
// Login uses the cached refresh token (auth_tokens) where possible; `return`
// necessarily uses passwords, and will prompt for a Steam Guard code if asked.

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const fs = require('fs');
const readline = require('readline');
const { db, saveRefreshToken, getRefreshToken, clearRefreshToken, saveAccount } = require('./db');
const { parseSentGifts, parsePendingGifts } = require('./single');
const { fetchCommunityPage, getUserCountry, getAccountPoints } = require('./steam_helpers');

const https = require('https');

const API_KEY = 'EFB5DCE316D3146FD6EFA3BECB8BCB80';

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Public ban record: VAC / community / trade (economy) bans. Works without a
// login, so it is also the only red-flag source for accounts we can't log into.
function fetchPlayerBans(steamID64) {
    return new Promise((resolve) => {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${API_KEY}&steamids=${steamID64}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200 || data.trim().startsWith('<')) return resolve(null);
                try {
                    resolve((JSON.parse(data).players || [])[0] || null);
                } catch (_) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const COMMAND = (argv.shift() || '').toLowerCase();
const flags = {};
const positional = [];
argv.forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else positional.push(a);
});

function usage(code = 1) {
    console.log(`Usage:
  node lend_account.js check  <account> [--password=<pw>]
  node lend_account.js lend   <account> --to="friend" [--days=1] [--note="..."] [--password=<pw>]
  node lend_account.js list   [--all]
  node lend_account.js return <account> [--new-password=<pw>] [--old-password=<pw>]
                                        [--update-file=<path>] [--loan-id=<n>]`);
    process.exit(code);
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

function ask(question, { hidden = false } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) {
            // Suppress echo for secrets; readline still receives the keystrokes.
            const onData = (char) => {
                if (['\n', '\r', ''].includes(char.toString('utf8'))) process.stdin.removeListener('data', onData);
                else process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
            };
            process.stdin.on('data', onData);
        }
        rl.question(question, (answer) => {
            rl.close();
            if (hidden) process.stdout.write('\n');
            resolve(answer.trim());
        });
    });
}

// ---------------------------------------------------------------------------
// account lookup
// ---------------------------------------------------------------------------

function resolveAccountName(name) {
    const row = db
        .prepare('SELECT steam_id, account_name FROM accounts WHERE lower(account_name) = lower(?)')
        .get(name);
    if (row) return row.account_name;
    const tok = db
        .prepare('SELECT account_name FROM auth_tokens WHERE lower(account_name) = lower(?)')
        .get(name);
    return tok ? tok.account_name : name;
}

// ---------------------------------------------------------------------------
// snapshot: log in and record everything worth comparing later
// ---------------------------------------------------------------------------

/**
 * Log in and collect account state. Resolves with { ok, snapshot, reason? } and
 * never rejects. Uses the cached refresh token unless a password is supplied.
 */
function snapshotAccount(username, { password = null, timeout = 90000, log = console.log } = {}) {
    const tag = `[${username}]`;
    return new Promise((resolve) => {
        const client = new SteamUser({ renewRefreshTokens: true });
        const community = new SteamCommunity({ timeout: 15000 });
        const snap = {
            account_name: username,
            steam_id: null,
            persona: null,
            email: null,
            email_validated: null,
            country: null,
            guard: 'unknown (logged in with a cached token)',
            wallet_currency: null,
            wallet_balance: null,
            steam_level: null,
            steam_points: null,
            friends: null,
            licenses: null,
            pending_gifts: null,
            sent_gifts: null,
            // Red flags
            limited: null,           // Limited account (no $5 spend yet)
            community_banned: null,  // Banned from Steam Community
            locked: null,            // Locked by Steam Support
            can_invite_friends: null,
            vac_bans: null,
            vac_apps: null,
            game_bans: null,
            economy_ban: null,       // Trade/market standing: none | probation | banned
            days_since_last_ban: null,
            taken_at: now()
        };
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { client.logOff(); } catch (_) {}
            resolve(result);
        };

        // Partial data is still useful — return whatever arrived by the deadline.
        const timer = setTimeout(() => {
            log(`${tag} snapshot timed out — returning partial data`);
            finish({ ok: true, partial: true, snapshot: snap });
        }, timeout);

        client.on('error', (err) => {
            log(`${tag} error: ${err.message}`);
            if (/InvalidPassword|AccessDenied|Expired/i.test(err.message) && !password) {
                clearRefreshToken(username);
                log(`${tag} cleared the dead cached refresh token`);
            }
            finish({ ok: false, reason: err.message, snapshot: snap });
        });

        client.on('refreshToken', (token) => saveRefreshToken(username, token));

        // Only fires on a password login, and only once the password was accepted.
        client.on('steamGuard', async (domain, callback) => {
            snap.guard = domain === null ? 'mobile authenticator (app code)' : `email (${domain})`;
            log(`${tag} Steam Guard: ${snap.guard}`);
            const code = await ask(`${tag} Steam Guard code: `);
            callback(code);
        });

        client.on('loggedOn', async () => {
            snap.steam_id = client.steamID.getSteamID64();
            log(`${tag} logged in: ${snap.steam_id}`);
            client.setPersona(SteamUser.EPersonaState.Online);
            client.gamesPlayed([]);

            client.getSteamLevels([snap.steam_id], (err, levels) => {
                if (!err && levels) snap.steam_level = levels[snap.steam_id] ?? null;
            });
            getUserCountry(client, snap.steam_id).then((c) => { snap.country = c ?? null; }).catch(() => {});
            getAccountPoints(client, snap.steam_id).then((p) => { snap.steam_points = p ?? null; }).catch(() => {});

            const bans = await fetchPlayerBans(snap.steam_id);
            if (bans) {
                snap.vac_bans = bans.NumberOfVACBans ?? null;
                snap.game_bans = bans.NumberOfGameBans ?? null;
                snap.economy_ban = bans.EconomyBan ?? null;
                snap.days_since_last_ban = bans.DaysSinceLastBan ?? null;
                if (snap.community_banned == null) snap.community_banned = !!bans.CommunityBanned;
            }
        });

        // Steam pushes these after login: the account's own view of its standing,
        // which the public ban API does not expose (limited / locked).
        client.on('accountLimitations', (limited, communityBanned, locked, canInviteFriends) => {
            snap.limited = !!limited;
            snap.community_banned = !!communityBanned;
            snap.locked = !!locked;
            snap.can_invite_friends = !!canInviteFriends;
        });

        client.on('vacBans', (numBans, appids) => {
            snap.vac_bans = numBans ?? 0;
            snap.vac_apps = (appids || []).join(', ') || null;
        });

        client.on('accountInfo', (name) => { snap.persona = name; });
        client.on('emailInfo', (address, validated) => {
            snap.email = address ?? null;
            snap.email_validated = !!validated;
        });
        client.on('wallet', (hasWallet, currency, balance) => {
            snap.wallet_currency = SteamUser.ECurrencyCode[currency] || String(currency || '');
            snap.wallet_balance = balance ?? null;
        });
        client.on('friendsList', () => {
            snap.friends = Object.keys(client.myFriends).filter(
                (id) => client.myFriends[id] === SteamUser.EFriendRelationship.Friend
            ).length;
        });
        client.on('licenses', (licenses) => {
            snap.licenses = licenses.filter((l) => l.package_id !== 0).length;
        });

        // The inventory page is the only source for pending/sent gift counts.
        client.on('webSession', async (sessionID, cookies) => {
            community.setCookies(cookies);
            const url = `https://steamcommunity.com/profiles/${snap.steam_id}/inventory/`;
            const { ok, data, error, status } = await fetchCommunityPage(community, url, { log, tag });
            if (ok) {
                try {
                    snap.sent_gifts = parseSentGifts(data).length;
                    snap.pending_gifts = parsePendingGifts(data).length;
                } catch (err) {
                    log(`${tag} gift parse failed: ${err.message}`);
                }
            } else {
                log(`${tag} inventory fetch failed: ${error?.message || `status ${status}`}`);
            }
            // Give the remaining async lookups (level/country/points) a moment to land.
            await sleep(4000);
            finish({ ok: true, snapshot: snap });
        });

        if (password) {
            log(`${tag} logging in with a password`);
            client.logOn({ accountName: username, password });
        } else {
            const token = getRefreshToken(username);
            if (!token) {
                return finish({
                    ok: false,
                    reason: 'no cached refresh token — pass --password=<pw> or run single.js first',
                    snapshot: snap
                });
            }
            log(`${tag} using cached refresh token`);
            client.logOn({ refreshToken: token });
        }
    });
}

const FIELDS = [
    ['persona', 'Persona'],
    ['email', 'Email'],
    ['country', 'Country'],
    ['guard', 'Steam Guard'],
    ['wallet_balance', 'Wallet'],
    ['steam_level', 'Level'],
    ['steam_points', 'Points'],
    ['friends', 'Friends'],
    ['licenses', 'Licenses'],
    ['pending_gifts', 'Pending gifts'],
    ['sent_gifts', 'Sent gifts'],
    ['limited', 'Limited'],
    ['vac_bans', 'VAC bans'],
    ['game_bans', 'Game bans'],
    ['economy_ban', 'Trade status'],
    ['community_banned', 'Community ban'],
    ['locked', 'Locked']
];

// Turn a snapshot into human-readable warnings, worst first.
function redFlags(snap) {
    const flags = [];
    if (snap.locked) flags.push('ACCOUNT LOCKED by Steam Support — unusable until resolved');
    if (snap.community_banned) flags.push('COMMUNITY BANNED — profile/market/community features blocked');
    if (snap.vac_bans) {
        flags.push(`VAC ban x${snap.vac_bans}${snap.vac_apps ? ` (apps: ${snap.vac_apps})` : ''} — permanent`);
    }
    if (snap.game_bans) flags.push(`${snap.game_bans} developer-issued game ban(s)`);
    if (snap.economy_ban && snap.economy_ban !== 'none') {
        flags.push(`TRADE/MARKET ${String(snap.economy_ban).toUpperCase()} — gifting and trading blocked`);
    }
    if (snap.limited) flags.push('LIMITED ACCOUNT — needs a $5 purchase before it can add friends / trade / gift');
    if (snap.can_invite_friends === false) flags.push('Cannot invite friends (usually a knock-on effect of being limited)');
    if (snap.email_validated === false) flags.push('Email NOT validated — Steam restricts some actions until it is');
    if (snap.days_since_last_ban && (snap.vac_bans || snap.game_bans)) {
        flags.push(`Last ban was ${snap.days_since_last_ban} day(s) ago`);
    }
    return flags;
}

function printRedFlags(snap) {
    const flags = redFlags(snap);
    console.log('\n=== Red flags ===');
    if (flags.length === 0) {
        // limited/vac_bans stay null if the login never completed — don't claim "clean" then.
        const checked = snap.limited != null || snap.vac_bans != null;
        console.log(checked ? '  None — account is clean.' : '  Could not determine (login did not complete).');
    } else {
        flags.forEach((f) => console.log(`  ! ${f}`));
    }
    return flags;
}

function printSnapshot(snap) {
    console.log(`\n=== ${snap.account_name} (${snap.steam_id || 'unknown steamID'}) ===`);
    FIELDS.forEach(([key, label]) => {
        let value = snap[key];
        if (key === 'wallet_balance' && value != null) value = `${snap.wallet_currency || ''} ${value}`.trim();
        if (key === 'email' && snap.email_validated === false) value = `${value} (NOT validated)`;
        console.log(`  ${label.padEnd(14)} ${value ?? '(unknown)'}`);
    });
}

function printDiff(before, after) {
    console.log('\n=== Changes while lent out ===');
    let changes = 0;
    FIELDS.forEach(([key, label]) => {
        // Guard type is only observable on a password login, so it is not comparable.
        if (key === 'guard') return;
        const a = before[key];
        const b = after[key];
        if (a == null || b == null) return;
        if (a !== b) {
            changes++;
            console.log(`  ${label.padEnd(14)} ${a}  ->  ${b}`);
        }
    });
    if (!changes) console.log('  No changes in the tracked fields.');
}

// ---------------------------------------------------------------------------
// loans table
// ---------------------------------------------------------------------------

const insertLoan = db.prepare(`
INSERT INTO account_loans (account_name, account_steam_id, borrower, note, lent_at, due_at, snapshot_json, created_at, updated_at)
VALUES (@account_name, @account_steam_id, @borrower, @note, @lent_at, @due_at, @snapshot_json, @now, @now)
`);
const openLoanFor = db.prepare(
    'SELECT * FROM account_loans WHERE lower(account_name) = lower(?) AND returned_at IS NULL ORDER BY lent_at DESC LIMIT 1'
);
const loanByID = db.prepare('SELECT * FROM account_loans WHERE id = ?');
const closeLoan = db.prepare(`
UPDATE account_loans
SET returned_at = @returned_at, password_changed = @password_changed, return_json = @return_json, updated_at = @returned_at
WHERE id = @id
`);

function fmt(ts) {
    return ts ? new Date(ts * 1000).toLocaleString() : '-';
}

function fmtLeft(seconds) {
    const abs = Math.abs(seconds);
    const d = Math.floor(abs / 86400);
    const h = Math.floor((abs % 86400) / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const text = `${d}d ${h}h ${m}m`;
    return seconds < 0 ? `OVERDUE by ${text}` : `${text} left`;
}

// ---------------------------------------------------------------------------
// password probing
// ---------------------------------------------------------------------------

/**
 * Try one password. Resolves { valid, reason }.
 * A Steam Guard prompt means the password was ACCEPTED (Steam only asks for a
 * code after the password checks out), so it counts as valid — we abort there
 * rather than completing the login.
 */
function testPassword(username, password, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
        const client = new SteamUser();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { client.logOff(); } catch (_) {}
            resolve(result);
        };
        const timer = setTimeout(() => finish({ valid: null, reason: 'timeout' }), timeout);

        client.on('steamGuard', () => finish({ valid: true, reason: 'accepted (Steam Guard prompt)' }));
        client.on('loggedOn', () => finish({ valid: true, reason: 'accepted (logged in)' }));
        client.on('error', (err) => {
            const invalid = /InvalidPassword|AccountLogonDenied|AccessDenied/i.test(err.message);
            finish({ valid: invalid ? false : null, reason: err.message });
        });

        client.logOn({ accountName: username, password });
    });
}

// ---------------------------------------------------------------------------
// credentials file rewrite
// ---------------------------------------------------------------------------

/**
 * Replace the password for `username` in a credentials file, in place.
 * Supports the two formats used across this repo:
 *   username----password----email----steamID[...]        (password = col 2)
 *   id|email|extra|username|password[...]                (password = col 5)
 * Writes a .bak copy first. Returns the number of lines changed.
 */
function updatePasswordInFile(filePath, username, newPassword) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let changed = 0;

    const updated = lines.map((line) => {
        if (!line.trim()) return line;
        if (line.includes('----')) {
            const parts = line.split('----');
            if (parts[0] && parts[0].toLowerCase() === username.toLowerCase()) {
                parts[1] = newPassword;
                changed++;
                return parts.join('----');
            }
            return line;
        }
        const parts = line.split('|');
        if (parts.length >= 5 && parts[3] && parts[3].toLowerCase() === username.toLowerCase()) {
            parts[4] = newPassword;
            changed++;
            return parts.join('|');
        }
        return line;
    });

    if (changed) {
        fs.copyFileSync(filePath, `${filePath}.bak`);
        fs.writeFileSync(filePath, updated.join(eol));
    }
    return changed;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdCheck(username) {
    const { ok, reason, snapshot, partial } = await snapshotAccount(username, {
        password: typeof flags.password === 'string' ? flags.password : null
    });
    if (!ok) {
        console.log(`\nSnapshot failed: ${reason}`);
        process.exit(1);
    }
    printSnapshot(snapshot);
    printRedFlags(snapshot);
    if (partial) console.log('\n(partial — some lookups did not finish before the timeout)');
    if (snapshot.wallet_balance) {
        console.log('\nNOTE: this account has wallet funds. They are spendable by whoever holds it.');
    }
    return snapshot;
}

async function cmdLend(username) {
    const borrower = typeof flags.to === 'string' ? flags.to : null;
    if (!borrower) {
        console.log('Missing --to="who is borrowing it"');
        process.exit(1);
    }
    const days = flags.days ? Number(flags.days) : 1;
    if (!Number.isFinite(days) || days <= 0) {
        console.log('--days must be a positive number');
        process.exit(1);
    }

    const existing = openLoanFor.get(username);
    if (existing) {
        console.log(`'${username}' is already lent to ${existing.borrower} (loan #${existing.id}, due ${fmt(existing.due_at)}).`);
        console.log('Close it first:  node lend_account.js return ' + username);
        process.exit(1);
    }

    console.log('Taking a pre-handover snapshot...');
    const snapshot = await cmdCheck(username);

    const lent_at = now();
    const due_at = lent_at + Math.round(days * 86400);
    const info = insertLoan.run({
        account_name: username,
        account_steam_id: snapshot.steam_id,
        borrower,
        note: typeof flags.note === 'string' ? flags.note : null,
        lent_at,
        due_at,
        snapshot_json: JSON.stringify(snapshot),
        now: lent_at
    });

    console.log(`\n=== Loan #${info.lastInsertRowid} recorded ===`);
    console.log(`  Account:  ${username}`);
    console.log(`  Borrower: ${borrower}`);
    console.log(`  Lent at:  ${fmt(lent_at)}`);
    console.log(`  Due at:   ${fmt(due_at)}  (${days} day${days === 1 ? '' : 's'})`);

    console.log(`\n=== Hand-over checklist ===`);
    console.log('  1. Give the Steam login + password only. NEVER the email account —');
    console.log('     with the mailbox they can reset the password back after you rotate it.');
    if (snapshot.guard.startsWith('mobile')) {
        console.log('  2. Guard is the mobile authenticator on your phone: you must relay a code');
        console.log('     for their first login, and again from any new device.');
    } else if (snapshot.guard.startsWith('email')) {
        console.log('  2. Guard is email-based: they cannot log in without a code from your');
        console.log('     mailbox, so you will have to relay it. Do not hand over mail access.');
    } else {
        console.log('  2. Steam Guard type unknown here (token login). Check it before handing over.');
    }
    if (snapshot.wallet_balance) {
        console.log(`  3. Wallet holds ${snapshot.wallet_currency || ''} ${snapshot.wallet_balance} — spendable by them.`);
    }
    console.log(`\nWhen it comes back:`);
    console.log(`  1. Change the password at https://store.steampowered.com/account/`);
    console.log(`     (Steam invalidates every other session on change — that is what cuts them off.)`);
    console.log(`  2. node lend_account.js return ${username} --new-password=<pw> --old-password=<pw>`);
}

function cmdList() {
    const rows = flags.all
        ? db.prepare('SELECT * FROM account_loans ORDER BY lent_at DESC').all()
        : db.prepare('SELECT * FROM account_loans WHERE returned_at IS NULL ORDER BY due_at ASC').all();

    if (rows.length === 0) {
        console.log(flags.all ? 'No loans recorded.' : 'No open loans.');
        return;
    }

    const ts = now();
    console.log(`\n=== ${flags.all ? 'All loans' : 'Open loans'} (${rows.length}) ===`);
    rows.forEach((r) => {
        const state = r.returned_at
            ? `returned ${fmt(r.returned_at)}${r.password_changed ? ' (password rotated)' : ' (password NOT verified)'}`
            : fmtLeft(r.due_at - ts);
        console.log(`  #${r.id} ${r.account_name} -> ${r.borrower || '?'}`);
        console.log(`      lent ${fmt(r.lent_at)} | due ${fmt(r.due_at)} | ${state}`);
        if (r.note) console.log(`      note: ${r.note}`);
    });

    const overdue = rows.filter((r) => !r.returned_at && r.due_at < ts);
    if (overdue.length) {
        console.log(`\n${overdue.length} loan(s) OVERDUE — change those passwords now:`);
        overdue.forEach((r) => console.log(`  https://store.steampowered.com/account/   then: node lend_account.js return ${r.account_name}`));
    }
}

async function cmdReturn(username) {
    const loan = flags['loan-id'] ? loanByID.get(Number(flags['loan-id'])) : openLoanFor.get(username);
    if (!loan) {
        console.log(`No open loan found for '${username}'. Continuing anyway (nothing to close).`);
    }

    let newPassword = typeof flags['new-password'] === 'string' ? flags['new-password'] : null;
    if (!newPassword) {
        console.log('\nChange the password first at https://store.steampowered.com/account/');
        newPassword = await ask('New password (leave empty to abort): ', { hidden: true });
        if (!newPassword) {
            console.log('Aborted.');
            process.exit(1);
        }
    }
    const oldPassword = typeof flags['old-password'] === 'string' ? flags['old-password'] : null;

    // 1. The old password must be dead. This is the whole point of the rotation.
    if (oldPassword) {
        console.log('\n=== Verifying the OLD password no longer works ===');
        const result = await testPassword(username, oldPassword);
        if (result.valid === false) {
            console.log(`  OK — old password rejected (${result.reason})`);
        } else if (result.valid === true) {
            console.log(`  WARNING: the OLD password STILL WORKS (${result.reason}).`);
            console.log('  The password was not actually changed — your friend still has access.');
            process.exit(1);
        } else {
            console.log(`  Inconclusive: ${result.reason} — could not confirm. Re-check manually.`);
        }
        await sleep(3000); // don't stack two logins back to back
    } else {
        console.log('\n(no --old-password given — skipping the "is the old password dead?" check)');
    }

    // 2. The cached token was invalidated by the password change; re-cache one.
    clearRefreshToken(username);
    console.log('\n=== Logging in with the NEW password to cache a fresh token ===');
    const { ok, reason, snapshot } = await snapshotAccount(username, { password: newPassword });
    if (!ok) {
        console.log(`  Login with the new password FAILED: ${reason}`);
        console.log('  Nothing was recorded. Fix the password and re-run.');
        process.exit(1);
    }
    console.log('  New password works; refresh token cached.');
    printSnapshot(snapshot);
    if (snapshot.steam_id) {
        saveAccount({ steam_id: snapshot.steam_id, account_name: username, persona: snapshot.persona });
    }

    // 3. Diff against the pre-loan state.
    if (loan?.snapshot_json) {
        try {
            printDiff(JSON.parse(loan.snapshot_json), snapshot);
        } catch (err) {
            console.log(`Could not diff the pre-loan snapshot: ${err.message}`);
        }
    }

    // 4. Optionally rewrite the stored password.
    if (typeof flags['update-file'] === 'string') {
        const filePath = flags['update-file'];
        if (!fs.existsSync(filePath)) {
            console.log(`\n--update-file: not found: ${filePath}`);
        } else {
            const changed = updatePasswordInFile(filePath, username, newPassword);
            console.log(`\n=== Credentials file ===`);
            console.log(changed
                ? `  Updated ${changed} line(s) in ${filePath} (backup at ${filePath}.bak)`
                : `  No line for '${username}' found in ${filePath} — left untouched`);
        }
    } else {
        console.log('\nReminder: the stored password is now stale. Pass --update-file=<path> to rewrite it.');
    }

    // 5. Close the loan.
    if (loan) {
        const ts = now();
        closeLoan.run({
            id: loan.id,
            returned_at: ts,
            password_changed: oldPassword ? 1 : 0,
            return_json: JSON.stringify(snapshot)
        });
        console.log(`\nLoan #${loan.id} closed (${username} <- ${loan.borrower || '?'}).`);
    }
}

// ---------------------------------------------------------------------------

module.exports = { snapshotAccount, testPassword, updatePasswordInFile, redFlags, fetchPlayerBans };

if (require.main !== module) return;

(async () => {
    if (COMMAND === 'list') {
        cmdList();
        process.exit(0);
    }

    if (!['check', 'lend', 'return'].includes(COMMAND)) usage();

    const rawName = positional.shift();
    if (!rawName) usage();
    const username = resolveAccountName(rawName);

    if (COMMAND === 'check') await cmdCheck(username);
    else if (COMMAND === 'lend') await cmdLend(username);
    else if (COMMAND === 'return') await cmdReturn(username);

    process.exit(0);
})();
