(function () {
  "use strict";

  var lightThemeLabel = "Dark theme";
  var darkThemeLabel = "Light theme";
  var translateInitialized = false;
  var translateScriptLoading = false;
  var translateReadyCallbacks = [];
  var showLangMenu = false;
  var themeTransitionTimer = null;
  var themeTransitionDuration = 560;

  function safeLocalGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeLocalSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Local file previews can block storage; theme still works for this page.
    }
  }

  function safeSessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeSessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (error) {
      // Keep modal controls clickable even when sessionStorage is unavailable.
    }
  }

  function getStoredTheme() {
    return safeLocalGet("theme") || "dark";
  }

  document.documentElement.setAttribute("data-theme", getStoredTheme());

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback);
    } else {
      callback();
    }
  }

  function getBody() {
    return document.body;
  }

  function setButtonLabels(theme) {
    document.querySelectorAll(".theme-toggle").forEach(function (button) {
      button.textContent = theme === "dark" ? darkThemeLabel : lightThemeLabel;
    });
  }

  function getSiteRootPrefix() {
    var scripts = document.getElementsByTagName("script");
    var i;
    var src;

    for (i = 0; i < scripts.length; i += 1) {
      src = scripts[i].getAttribute("src") || "";

      if (src.indexOf("site.js") !== -1) {
        return src.split("site.js")[0];
      }
    }

    return "/";
  }

  function rootAsset(name) {
    return getSiteRootPrefix() + name;
  }

  function getLocalIndexHref(rawHref, baseHref) {
    var url;

    try {
      url = new URL(rawHref, baseHref || window.location.href);
    } catch (error) {
      return rawHref;
    }

    if (url.protocol !== "file:" || !/\/$/.test(url.pathname)) {
      return url.href;
    }

    url.pathname += "index.html";
    return url.href;
  }

  function initLocalFolderLinks() {
    if (window.location.protocol !== "file:") {
      return;
    }

    document.querySelectorAll("a[href]").forEach(function (link) {
      var rawHref = link.getAttribute("href") || "";
      var url;

      if (!rawHref || rawHref.indexOf("#") === 0 || rawHref.indexOf("?") === 0 || /^[a-z]+:/i.test(rawHref)) {
        return;
      }

      url = getLocalIndexHref(rawHref, window.location.href);

      if (url === rawHref) {
        return;
      }

      link.setAttribute("href", url);
    });
  }

  function inferThemeImageSources(image) {
    var current = image.getAttribute("src") || "";
    var darkSrc = image.getAttribute("data-dark-src");
    var lightSrc = image.getAttribute("data-light-src");

    if (darkSrc && lightSrc) {
      return { dark: darkSrc, light: lightSrc };
    }

    if (current.indexOf("kcodeEN") !== -1) {
      return { dark: rootAsset("kcodeEN.jpg"), light: rootAsset("kcodeEN.jpg") };
    }

    if (current.indexOf("kcodeRU") !== -1) {
      return { dark: rootAsset("kcodeRU.jpg"), light: rootAsset("kcodeRU.jpg") };
    }

    if (current.indexOf("codeEN") !== -1 || location.pathname.indexOf("/en/") !== -1) {
      return { dark: rootAsset("codeENb.jpg"), light: rootAsset("codeENw.jpg") };
    }

    return { dark: rootAsset("codeRUb.jpg"), light: rootAsset("codeRUw.jpg") };
  }

  function updateThemeImage(theme) {
    var image = document.getElementById("theme-sensitive-image");

    if (!image) {
      return;
    }

    var sources = inferThemeImageSources(image);
    image.src = theme === "dark" ? sources.dark : sources.light;
  }

  function updateInstructionThemeImages(theme) {
    document.querySelectorAll("[data-inst-theme-image]").forEach(function (image) {
      var sources = inferThemeImageSources(image);
      image.setAttribute("data-dark-src", sources.dark);
      image.setAttribute("data-light-src", sources.light);
      image.src = theme === "dark" ? sources.dark : sources.light;
    });
  }

  function applyTheme(theme, persist) {
    var body = getBody();

    if (!body) {
      return;
    }

    body.classList.toggle("dark", theme === "dark");
    document.documentElement.setAttribute("data-theme", theme);
    setButtonLabels(theme);
    updateThemeImage(theme);
    updateInstructionThemeImages(theme);

    if (persist) {
      safeLocalSet("theme", theme);
    }
  }

  window.toggleTheme = function () {
    var nextTheme = document.body.classList.contains("dark") ? "light" : "dark";
    var body = getBody();

    if (!body || themeTransitionTimer) {
      return;
    }

    body.classList.add("site-theme-transition");
    applyTheme(nextTheme, true);

    themeTransitionTimer = setTimeout(function () {
      body.classList.remove("site-theme-transition");
      themeTransitionTimer = null;
    }, themeTransitionDuration);
  };

  function initTheme() {
    var body = getBody();

    if (!body || !body.hasAttribute("data-site-theme")) {
      return;
    }

    var savedTheme = safeLocalGet("theme");
    var defaultTheme = body.getAttribute("data-site-default-theme");
    var initialTheme = savedTheme || defaultTheme || "dark";

    applyTheme(initialTheme, false);

    document.querySelectorAll(".theme-toggle").forEach(function (button) {
      button.setAttribute("data-site-theme-toggle-ready", "true");
    });
  }

  window.handleThemeToggleClick = function (event) {
    if (event) {
      event.preventDefault();
    }

    window.toggleTheme();
  };

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest(".theme-toggle") : null;

    if (!button) {
      return;
    }

    window.handleThemeToggleClick(event);
  });

  function initLoader() {
    var body = getBody();
    var loader = document.getElementById("loader");

    if (!body || !loader || !body.hasAttribute("data-site-loader")) {
      return;
    }

    loader.style.display = "none";
  }

  function initToTop() {
    var body = getBody();
    var button = document.getElementById("toTop");

    if (!body || !button || !body.hasAttribute("data-site-totop")) {
      return;
    }

    function updateVisibility() {
      button.style.display = document.body.scrollTop > 100 || document.documentElement.scrollTop > 100 ? "block" : "none";
    }

    window.addEventListener("scroll", updateVisibility);
    button.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    updateVisibility();
  }

  function closeZoomModal(modal) {
    modal.classList.remove("active");
    setTimeout(function () {
      modal.remove();
    }, 400);
  }

  function openZoomModal(sourceImage, variant) {
    var modal = document.createElement("div");
    var wrapper = document.createElement("div");
    var zoomedImage = document.createElement("img");
    var rect = sourceImage.getBoundingClientRect();
    var isStalcraftCase = sourceImage.closest(".sc-case-big");

    if (isStalcraftCase) {
      variant = "sc-case";
    }

    modal.className = "image-zoom-modal image-zoom-modal--" + variant;
    wrapper.className = "zoomed-image-wrapper";
    zoomedImage.className = "zoomed-image";
    zoomedImage.src = sourceImage.src;
    zoomedImage.alt = "";

    wrapper.appendChild(zoomedImage);
    modal.appendChild(wrapper);
    document.body.appendChild(modal);

    wrapper.style.position = isStalcraftCase ? "fixed" : "absolute";
    if (isStalcraftCase) {
      wrapper.style.left = "50%";
      wrapper.style.top = "50%";
      wrapper.style.width = "auto";
      wrapper.style.height = "auto";
      wrapper.style.transform = "translate(-50%,-50%) scale(.92)";
    } else {
      wrapper.style.left = rect.left + "px";
      wrapper.style.top = rect.top + "px";
      wrapper.style.width = rect.width + "px";
      wrapper.style.height = rect.height + "px";
    }

    setTimeout(function () {
      modal.classList.add("active");
      wrapper.style.left = "50%";
      wrapper.style.top = "50%";
      wrapper.style.transform = "translate(-50%,-50%) scale(1)";
    }, 10);

    modal.addEventListener("click", function () {
      closeZoomModal(modal);
    });

    wrapper.addEventListener("click", function (event) {
      event.stopPropagation();
      closeZoomModal(modal);
    });
  }

  function bindZoom(selector, variant) {
    if (window.innerWidth <= 767) {
      return;
    }

    document.querySelectorAll(selector).forEach(function (image) {
      if (image.hasAttribute("data-site-zoom-bound")) {
        return;
      }

      image.setAttribute("data-site-zoom-bound", "true");
      image.style.cursor = "zoom-in";
      image.addEventListener("click", function (event) {
        event.stopPropagation();
        openZoomModal(image, variant);
      });
    });
  }

  function initZoom() {
    var body = getBody();

    if (!body) {
      return;
    }

    if (body.hasAttribute("data-site-card-zoom")) {
      if (body.classList.contains("skin-acc12")) {
        bindZoom(".acc-gallery .saydis-md img", "card");
      } else {
        bindZoom(".card-wrap .video img, .card-item .media img, .card-item img, .saydis-md img, .seva-row-media img", "card");
      }
    }

    if (body.hasAttribute("data-site-image-zoom")) {
      bindZoom(".image-in", "image");
    }
  }

  function getCountLabel(count, singular, plural) {
    return count === 1 ? singular : plural;
  }

  function getCatalogCardAmount(card) {
    var explicitCount = card.getAttribute("data-site-count");
    var qty = card.querySelector(".saydis-qty");
    var match;

    if (explicitCount) {
      return parseInt(explicitCount, 10) || 1;
    }

    if (!qty) {
      return 1;
    }

    match = qty.textContent.replace(/\s+/g, "").match(/^x?([\d.,]+)/i);

    if (!match) {
      return 1;
    }

    return parseInt(match[1].replace(/[,.].*$/, ""), 10) || 1;
  }

  function initAutoSectionCounts() {
    var body = getBody();

    if (!body || !body.hasAttribute("data-site-auto-count")) {
      return;
    }

    var singular = body.getAttribute("data-site-count-singular") || "item";
    var plural = body.getAttribute("data-site-count-plural") || "items";

    document.querySelectorAll(".saydis-list-section, .seva-list-section").forEach(function (section) {
      var aside = section.querySelector("aside");
      var title = aside ? aside.querySelector("h2") : null;
      var count = 0;
      var sectionCount = section.getAttribute("data-site-section-count");
      var counter = aside ? aside.querySelector(".saydis-section-count, .seva-section-count") : null;
      var cards = section.querySelectorAll(".saydis-card, .saydis-item, .seva-row-card");

      if (sectionCount) {
        count = parseInt(sectionCount, 10) || 0;
      } else {
        cards.forEach(function (card) {
          count += getCatalogCardAmount(card);
        });
      }

      if (!aside || !title || count < 1) {
        return;
      }

      if (!counter) {
        counter = document.createElement("span");
        title.insertAdjacentElement("afterend", counter);
      }

      counter.className = "saydis-section-count";
      counter.innerHTML = "<b>" + count + "</b><em>" + getCountLabel(count, singular, plural) + "</em>";
    });
  }

  function initSaydisTitleCount() {
    var body = getBody();

    if (!body || !body.classList.contains("saydis-new")) {
      return;
    }

    document.querySelectorAll(".saydis-hero__copy h1").forEach(function (title) {
      var text;
      var match;
      var count;

      if (title.querySelector(".saydis-title-count")) {
        return;
      }

      text = title.textContent.trim();
      match = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);

      if (!match) {
        return;
      }

      title.textContent = match[1].trim();
    });
  }

  function initManualTotalCount() {
    var body = getBody();
    var target;
    var total = 0;
    var singular;
    var plural;

    if (!body || (!body.hasAttribute("data-site-manual-total") && !body.hasAttribute("data-site-total-from-sections") && !body.hasAttribute("data-site-total-from-cards") && !body.hasAttribute("data-site-total-mixed-section"))) {
      return;
    }

    singular = body.getAttribute("data-site-count-singular") || "item";
    plural = body.getAttribute("data-site-count-plural") || "items";

    if (body.hasAttribute("data-site-total-mixed-section")) {
      var weightedSection = body.getAttribute("data-site-total-mixed-section").trim().toLowerCase();

      document.querySelectorAll(".saydis-list-section").forEach(function (section) {
        var title = section.querySelector("aside h2");
        var cards = section.querySelectorAll(".saydis-card, .saydis-item, .seva-row-card");
        var titleText = title ? title.textContent.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase() : "";

        if (titleText === weightedSection) {
          cards.forEach(function (card) {
            total += getCatalogCardAmount(card);
          });
        } else {
          total += cards.length;
        }
      });
    } else if (body.hasAttribute("data-site-total-from-cards")) {
      total = document.querySelectorAll(".saydis-list-section .saydis-card, .saydis-list-section .saydis-item, .saydis-list-section .seva-row-card").length;
    } else {
      document.querySelectorAll(".saydis-list-section .saydis-section-count").forEach(function (counter) {
        var section = counter.closest(".saydis-list-section");
        var sectionTotal = section ? section.getAttribute("data-site-section-total") : "";
        var text = counter.textContent.trim();
        var match = text.match(/(\d+)/);

        if (sectionTotal) {
          total += parseInt(sectionTotal, 10) || 0;
          return;
        }

        if (!match) {
          return;
        }

        total += parseInt(match[1], 10);
      });
    }

    target = document.querySelector("[data-site-total-count]");

    if (!target || !total) {
      return;
    }

    target.textContent = total + " " + getCountLabel(total, singular, plural);
  }

  function initNoSelect() {
    var body = getBody();

    if (!body || !body.hasAttribute("data-site-selection-lock")) {
      return;
    }

    function preventSelection() {
      return false;
    }

    document.ondragstart = preventSelection;
    document.onselectstart = preventSelection;
    document.oncontextmenu = preventSelection;
  }

  function hideGoogleBanner() {
    var selectors = [
      ".goog-te-banner-frame",
      "iframe.skiptranslate",
      "body > .skiptranslate",
      "#goog-gt-tt",
      "#goog-gt-vt",
      ".goog-tooltip",
      ".goog-te-balloon-frame",
      ".VIpgJd-ZVi9od-ORHb-OEVmcd",
      ".VIpgJd-ZVi9od-aZ2wEe",
      ".VIpgJd-ZVi9od-aZ2wEe-wOHMyf",
      ".VIpgJd-yAWNEb-L7lbkb"
    ];

    selectors.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (item) {
        item.style.display = "none";
        item.style.visibility = "hidden";
        item.style.opacity = "0";
        item.style.pointerEvents = "none";
      });
    });

    document.body.style.top = "0px";
    document.body.style.position = "static";
    document.documentElement.style.top = "0px";
    document.documentElement.classList.add("goog-translate-active");
  }

  function getRequestedLanguage() {
    var match = location.search.match(/[?&]lang=([^&]+)/);

    if (!match) {
      return "";
    }

    return decodeURIComponent(match[1]).replace(/[^a-zA-Z-]/g, "");
  }

  function getPageLanguage() {
    var lang = (document.documentElement.getAttribute("lang") || "ru").toLowerCase();

    return lang.indexOf("en") === 0 ? "en" : "ru";
  }

  function clearTranslationCookies() {
    var host = window.location.hostname;
    var pieces = host.split(".");
    var domains = ["", host, "." + host];

    if (pieces.length > 2) {
      domains.push("." + pieces.slice(-2).join("."));
    }

    ["googtrans", "googte", "googtransopt"].forEach(function (name) {
      domains.forEach(function (domain) {
        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/" + (domain ? ";domain=" + domain : "");
      });
    });
  }

  function flushTranslateReadyCallbacks() {
    var callbacks = translateReadyCallbacks.splice(0);

    callbacks.forEach(function (callback) {
      callback();
    });
  }

  function loadGoogleTranslateScript() {
    var script;

    if (translateScriptLoading || document.querySelector("script[data-site-google-translate]")) {
      return;
    }

    translateScriptLoading = true;
    script = document.createElement("script");
    script.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
    script.async = true;
    script.setAttribute("data-site-google-translate", "");
    document.head.appendChild(script);
  }

  function whenGoogleTranslateReady(callback) {
    if (translateInitialized && document.querySelector(".goog-te-combo")) {
      callback();
      return;
    }

    translateReadyCallbacks.push(callback);
    loadGoogleTranslateScript();
  }

  function applyLanguageToSelect(lang) {
    var select = document.querySelector(".goog-te-combo");

    if (!select) {
      return false;
    }

    select.value = lang;
    select.dispatchEvent(new Event("change"));
    setTimeout(hideGoogleBanner, 200);
    return true;
  }

  window.googleTranslateElementInit = function () {
    if (!translateInitialized && window.google && google.translate) {
      new google.translate.TranslateElement({
        pageLanguage: getPageLanguage(),
        autoDisplay: false,
        includedLanguages: "ru,en,uk,tr,pl,de,fr,es,zh-CN,ar,it,pt,ja,ko"
      }, "google_translate_element");
      translateInitialized = true;
      setTimeout(hideGoogleBanner, 100);
      setTimeout(flushTranslateReadyCallbacks, 250);
    }
  };

  window.changeLanguage = function (lang) {
    if (applyLanguageToSelect(lang)) {
      return;
    }

    whenGoogleTranslateReady(function () {
      var attempts = 0;
      var interval = setInterval(function () {
        attempts += 1;

        if (applyLanguageToSelect(lang) || attempts > 40) {
          clearInterval(interval);
        }
      }, 200);
    });
  };

  window.resetTranslation = function () {
    clearTranslationCookies();

    var select = document.querySelector(".goog-te-combo");

    if (select) {
      select.value = getPageLanguage();
      select.dispatchEvent(new Event("change"));
    }

    setTimeout(function () {
      location.reload();
    }, 300);
  };

  function applyRequestedLanguage() {
    var lang = getRequestedLanguage();

    if (!lang) {
      return;
    }

    if (lang === getPageLanguage()) {
      clearTranslationCookies();
      hideGoogleBanner();
      return;
    }

    window.changeLanguage(lang);
  }

  function openLangMenu(menu) {
    menu.style.display = "block";
    setTimeout(function () {
      menu.classList.add("active");
    }, 10);
    showLangMenu = true;
  }

  function closeLangMenu(menu) {
    menu.classList.remove("active");
    setTimeout(function () {
      menu.style.display = "none";
    }, 300);
    showLangMenu = false;
  }

  function preserveTextNode(node, value) {
    var text = value || (node.textContent || "").trim();

    if (!text) {
      return;
    }

    node.setAttribute("translate", "no");
    node.setAttribute("data-preserve-text", text);
    node.classList.add("notranslate");

    if ((node.textContent || "").trim() !== text) {
      node.textContent = text;
    }
  }

  function protectStaticSiteText(scope) {
    var root = scope || document;

    root.querySelectorAll(".saydis-hero__copy h1, .saydis-related a, .saydis-list-section > aside h2, .saydis-round-title").forEach(function (node) {
      if (node.closest("body.skin-stalcraft") && node.closest(".saydis-list-section, .sc-list")) {
        return;
      }

      preserveTextNode(node);
    });

    root.querySelectorAll("[data-preserve-text]").forEach(function (node) {
      preserveTextNode(node, node.getAttribute("data-preserve-text"));
    });

    document.title = document.querySelector("title[translate='no']") ? document.title : document.title;
  }

  function watchProtectedText() {
    document.querySelectorAll("[data-preserve-text]").forEach(function (node) {
      if (node.hasAttribute("data-preserve-watch")) {
        return;
      }

      node.setAttribute("data-preserve-watch", "");
      new MutationObserver(function () {
        preserveTextNode(node, node.getAttribute("data-preserve-text"));
      }).observe(node, { childList: true, characterData: true, subtree: true });
    });
  }

  function getNativeInstructionLanguage(lang) {
    return (String(lang || "").toLowerCase() === "en") ? "en" : "ru";
  }

  function hasActiveGoogleTranslation() {
    var select = document.querySelector(".goog-te-combo");

    return document.cookie.indexOf("googtrans") !== -1 ||
      document.documentElement.classList.contains("translated-ltr") ||
      document.documentElement.classList.contains("translated-rtl") ||
      !!(select && select.value);
  }

  function setUnifiedGoogleState(lang) {
    document.querySelectorAll("[data-google-lang]").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-google-lang") === lang);
    });
  }

  function buildUnifiedGooglePanel(panel) {
    var languages = [
      ["uk", "\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430"],
      ["tr", "T\u00fcrk\u00e7e"],
      ["pl", "Polski"],
      ["de", "Deutsch"],
      ["fr", "Fran\u00e7ais"],
      ["es", "Espa\u00f1ol"],
      ["zh-CN", "\u4e2d\u6587"],
      ["ar", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629"],
      ["it", "Italiano"],
      ["pt", "Portugu\u00eas"],
      ["ja", "\u65e5\u672c\u8a9e"],
      ["ko", "\ud55c\uad6d\uc5b4"]
    ];
    var options;
    var googleElement;

    if (!panel) {
      return;
    }

    options = panel.querySelector(".inst-google-options");

    if (!options) {
      options = document.createElement("div");
      options.className = "inst-google-options";
      panel.appendChild(options);
    }

    if (!options.children.length) {
      options.innerHTML = languages.map(function (language) {
        return '<button class="inst-google-option" type="button" data-google-lang="' + language[0] + '">' + language[1] + "</button>";
      }).join("");
    }

    googleElement = panel.querySelector("#google_translate_element") || document.getElementById("google_translate_element");

    if (!googleElement) {
      googleElement = document.createElement("div");
      googleElement.id = "google_translate_element";
      googleElement.setAttribute("aria-hidden", "true");
      panel.appendChild(googleElement);
    }
  }

  function updateUnifiedInstructionLabels(lang) {
    var subtitle = document.getElementById("instSubtitle");
    var relatedLabel = document.getElementById("instRelatedLabel");
    var googleToggle = document.getElementById("instGoogleToggle");
    var relatedLinks = document.querySelectorAll(".saydis-related a").length;

    if (subtitle) {
      subtitle.textContent = lang === "en" ? "Activation instructions" : "\u0418\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u044f \u043f\u043e \u0430\u043a\u0442\u0438\u0432\u0430\u0446\u0438\u0438";
    }

    if (relatedLabel) {
      if (lang === "en") {
        relatedLabel.textContent = relatedLinks === 1 ? "Related product" : "Related products";
      } else {
        relatedLabel.textContent = relatedLinks === 1 ? "\u0421\u043e\u043f\u0443\u0442\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0439 \u0442\u043e\u0432\u0430\u0440" : "\u0421\u043e\u043f\u0443\u0442\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0435 \u0442\u043e\u0432\u0430\u0440\u044b";
      }
    }

    if (googleToggle) {
      googleToggle.textContent = lang === "en" ? "Other languages" : "\u0414\u0440\u0443\u0433\u0438\u0435 \u044f\u0437\u044b\u043a\u0438";
    }
  }

  function updateUnifiedInstructionText(lang) {
    document.querySelectorAll("[data-inst-text]").forEach(function (node) {
      node.hidden = node.getAttribute("data-inst-text") !== lang;
    });

    var title = document.querySelector("title[data-inst-title-ru][data-inst-title-en]");

    if (title) {
      title.textContent = lang === "en"
        ? title.getAttribute("data-inst-title-en")
        : title.getAttribute("data-inst-title-ru");
    }
  }

  function updateLogoHomeLanguage(lang) {
    document.querySelectorAll(".saydis-logo, .header__logo[data-home-root-logo]").forEach(function (logo) {
      var href = logo.getAttribute("href") || "";
      var clean = href.split("?")[0] || href;

      if (!href || href.indexOf("#") === 0) {
        return;
      }

      logo.setAttribute("href", lang === "en" ? clean + "?lang=en" : clean);
    });
  }

  function updateUnifiedHeaderMode() {
    document.querySelectorAll(".saydis-hero").forEach(function (hero) {
      hero.classList.toggle("inst-no-related", !hero.querySelector(".saydis-related"));
    });
  }

  function setUnifiedNativeLanguage(lang, options) {
    var body = getBody();
    var requested = getRequestedLanguage();

    if (!body) {
      return;
    }

    lang = getNativeInstructionLanguage(lang);
    options = options || {};

    if (!options.initial && hasActiveGoogleTranslation()) {
      safeLocalSet("saydis:instruction-language:" + location.pathname.split("/inst/")[0], lang);
      clearTranslationCookies();
      hideGoogleBanner();
      if (requested === lang) {
        location.reload();
        return;
      }
      location.replace("?lang=" + lang);
      return;
    }

    clearTranslationCookies();
    document.documentElement.lang = lang;
    body.setAttribute("data-inst-native-lang", lang);
    updateLogoHomeLanguage(lang);
    setUnifiedGoogleState("");

    document.querySelectorAll("[data-inst-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-inst-panel") !== lang;
    });

    document.querySelectorAll("[data-native-lang]").forEach(function (button) {
      var active = button.getAttribute("data-native-lang") === lang;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "true" : "false");
    });

    updateUnifiedInstructionLabels(lang);
    updateUnifiedInstructionText(lang);
    updateInstructionThemeImages(document.body.classList.contains("dark") ? "dark" : "light");
    protectStaticSiteText();
    watchProtectedText();
    safeLocalSet("saydis:instruction-language:" + location.pathname.split("/inst/")[0], lang);

    if (!options.skipHistory) {
      history.replaceState(null, "", "?lang=" + lang);
    }
  }

  function initUnifiedInstructions() {
    var body = getBody();
    var googleToggle = document.getElementById("instGoogleToggle");
    var googlePanel = document.getElementById("instGooglePanel");
    var requestedLang = getRequestedLanguage();
    var storageKey = "saydis:instruction-language:" + location.pathname.split("/inst/")[0];
    var initialLang;

    if (!body || !body.classList.contains("inst-unified")) {
      protectStaticSiteText();
      watchProtectedText();
      return;
    }

    body.removeAttribute("data-site-translate");
    updateUnifiedHeaderMode();
    buildUnifiedGooglePanel(googlePanel);
    protectStaticSiteText();
    watchProtectedText();

    document.querySelectorAll("[data-native-lang]").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        setUnifiedNativeLanguage(button.getAttribute("data-native-lang"));
      });
    });

    document.querySelectorAll("[data-google-lang]").forEach(function (button) {
      button.addEventListener("click", function () {
        var lang = button.getAttribute("data-google-lang");
        setUnifiedGoogleState(lang);
        window.changeLanguage(lang);
        setTimeout(hideGoogleBanner, 160);
        setTimeout(hideGoogleBanner, 600);
        setTimeout(function () {
          protectStaticSiteText();
        }, 800);
      });
    });

    if (googleToggle && googlePanel) {
      googleToggle.addEventListener("click", function () {
        var isOpen = googlePanel.hidden;
        googlePanel.hidden = !isOpen;
        googleToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        if (isOpen) {
          whenGoogleTranslateReady(hideGoogleBanner);
        }
      });
    }

    initialLang = requestedLang === "en" || requestedLang === "ru" ? requestedLang : safeLocalGet(storageKey) || "ru";
    setUnifiedNativeLanguage(initialLang, { initial: true, skipHistory: !requestedLang });

    if (requestedLang && requestedLang !== "ru" && requestedLang !== "en") {
      if (googlePanel) {
        googlePanel.hidden = false;
      }
      setUnifiedGoogleState(requestedLang);
      window.changeLanguage(requestedLang);
    }
  }

  function initSiteLanguageFooters() {
    var footers = document.querySelectorAll(".site-google-language-footer");

    if (!footers.length) {
      return;
    }

    footers.forEach(function (footer) {
      var panel = footer.querySelector(".inst-google-panel");
      var toggle = footer.querySelector(".inst-google-toggle");

      buildUnifiedGooglePanel(panel);
      hideGoogleBanner();

      if (toggle) {
        toggle.textContent = "\u0414\u0440\u0443\u0433\u0438\u0435 \u044f\u0437\u044b\u043a\u0438";
      }

      footer.querySelectorAll("[data-site-lang]").forEach(function (button) {
        button.classList.toggle("is-active", button.getAttribute("data-site-lang") === "ru");
      });

      footer.querySelectorAll("[data-site-lang]").forEach(function (button) {
        button.addEventListener("click", function () {
          var lang = button.getAttribute("data-site-lang");

          footer.querySelectorAll("[data-site-lang]").forEach(function (item) {
            item.classList.toggle("is-active", item === button);
          });

          if (lang === "ru") {
            window.resetTranslation();
            return;
          }

          setUnifiedGoogleState("");
          window.changeLanguage(lang);
          setTimeout(hideGoogleBanner, 160);
          setTimeout(hideGoogleBanner, 600);
          setTimeout(hideGoogleBanner, 1400);
          setTimeout(function () {
            protectStaticSiteText();
          }, 800);
        });
      });

      footer.querySelectorAll("[data-google-lang]").forEach(function (button) {
        button.addEventListener("click", function () {
          var lang = button.getAttribute("data-google-lang");

          setUnifiedGoogleState(lang);
          footer.querySelectorAll("[data-site-lang]").forEach(function (item) {
            item.classList.remove("is-active");
          });
          window.changeLanguage(lang);
          setTimeout(hideGoogleBanner, 160);
          setTimeout(hideGoogleBanner, 600);
          setTimeout(hideGoogleBanner, 1400);
          setTimeout(function () {
            protectStaticSiteText();
          }, 800);
        });
      });

      if (toggle && panel) {
        toggle.addEventListener("click", function () {
          var isOpen = panel.hidden;

          panel.hidden = !isOpen;
          toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");

          if (isOpen) {
            whenGoogleTranslateReady(hideGoogleBanner);
          }
        });
      }
    });
  }

  function setHomeLanguage(lang, options) {
    var body = getBody();

    if (!body) {
      return;
    }

    lang = getNativeInstructionLanguage(lang);
    options = options || {};

    clearTranslationCookies();
    document.documentElement.lang = lang;
    body.setAttribute("data-home-lang", lang);
    updateLogoHomeLanguage(lang);

    document.querySelectorAll("[data-home-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-home-panel") !== lang;
    });

    document.querySelectorAll("[data-home-lang]").forEach(function (button) {
      var active = button.getAttribute("data-home-lang") === lang;
      button.classList.toggle("is-active", active);
      button.classList.toggle("selected", active);
      button.setAttribute("aria-current", active ? "true" : "false");
    });

    document.querySelectorAll("[data-home-text]").forEach(function (node) {
      node.hidden = node.getAttribute("data-home-text") !== lang;
    });

    document.querySelectorAll("[data-home-inst-base]").forEach(function (link) {
      var base = link.getAttribute("data-home-inst-base");

      if (base) {
        link.setAttribute("href", base + "?lang=" + lang);
      }
    });

    safeLocalSet("saydis:home-language", lang);

    if (!options.skipHistory) {
      history.replaceState(null, "", lang === "en" ? "?lang=en" : location.pathname);
    }

    if (body.classList.contains("home-root") && typeof window.__saydisSyncHomeProducts === "function") {
      setTimeout(window.__saydisSyncHomeProducts, 0);
    }
  }

  function parseCssUrl(value) {
    var match;

    if (!value) {
      return "";
    }

    match = String(value).trim().match(/^url\((['"]?)(.*?)\1\)$/i);
    return match ? match[2] : "";
  }

  function parseBackgroundAxis(token, fallback) {
    var map = {
      left: 0,
      top: 0,
      center: 0.5,
      right: 1,
      bottom: 1
    };
    var lowered;
    var number;

    if (!token) {
      return fallback;
    }

    lowered = String(token).trim().toLowerCase();

    if (Object.prototype.hasOwnProperty.call(map, lowered)) {
      return map[lowered];
    }

    if (/%$/.test(lowered)) {
      number = parseFloat(lowered);

      if (!isNaN(number)) {
        return number / 100;
      }
    }

    number = parseFloat(lowered);

    if (!isNaN(number)) {
      return number;
    }

    return fallback;
  }

  function parseBackgroundPosition(value) {
    var tokens;
    var xToken;
    var yToken;

    if (!value) {
      return { x: 0.5, y: 0.5 };
    }

    tokens = String(value).trim().split(/\s+/);
    xToken = tokens[0];
    yToken = tokens[1];

    if (!yToken) {
      if (xToken === "top" || xToken === "bottom") {
        yToken = xToken;
        xToken = "center";
      } else {
        yToken = "center";
      }
    }

    return {
      x: parseBackgroundAxis(xToken, 0.5),
      y: parseBackgroundAxis(yToken, 0.5)
    };
  }

  function initHomeProductSlices() {
    var imageCache = {};
    var resizeObserver;
    var frame = 0;

    function clearSection(section) {
      section.removeAttribute("data-hp-sliced");
      section.querySelectorAll(".hp-link").forEach(function (link) {
        link.classList.remove("is-hp-last-single");
        link.style.removeProperty("--hp-last-width");
        link.style.removeProperty("--hp-slice-image");
        link.style.removeProperty("--hp-slice-width");
        link.style.removeProperty("--hp-slice-height");
        link.style.removeProperty("--hp-slice-x");
        link.style.removeProperty("--hp-slice-y");
        link.style.removeProperty("--hp-slice-opacity");
        link.style.removeProperty("--hp-slice-opacity-light");
        link.style.removeProperty("--hp-slice-filter");
      });
    }

    function getImage(url, callback) {
      var cached = imageCache[url];
      var image;

      if (cached && cached.loaded) {
        callback(cached.image);
        return;
      }

      if (cached) {
        cached.callbacks.push(callback);
        return;
      }

      image = new Image();
      imageCache[url] = {
        image: image,
        loaded: false,
        callbacks: [callback]
      };

      image.addEventListener("load", function () {
        var entry = imageCache[url];

        entry.loaded = true;
        entry.callbacks.splice(0).forEach(function (fn) {
          fn(image);
        });
      });

      image.addEventListener("error", function () {
        var entry = imageCache[url];

        entry.callbacks.splice(0).forEach(function () {});
      });

      image.src = url;
    }

    function applySlicesForSection(section) {
      var grid = section.querySelector(".hp-grid");
      var links = grid ? Array.prototype.slice.call(grid.querySelectorAll(".hp-link")) : [];
      var styles = getComputedStyle(section);
      var imageUrl = parseCssUrl(styles.getPropertyValue("--home-char"));
      var position = parseBackgroundPosition(styles.getPropertyValue("--home-char-pos"));
      var opacity = parseFloat(styles.getPropertyValue("--home-char-opacity"));
      var lightOpacity = isNaN(opacity) ? 0.38 : Math.min(opacity + 0.08, 0.62);
      var filter = (styles.getPropertyValue("--home-char-filter") || "none").trim() || "none";
      var scale = parseFloat(styles.getPropertyValue("--home-char-scale"));

      if (!grid || !links.length || !imageUrl) {
        clearSection(section);
        return;
      }

      links.forEach(function (link) {
        link.classList.remove("is-hp-last-single");
        link.style.removeProperty("--hp-last-width");
      });

      getImage(imageUrl, function (image) {
        var sectionRect;
        var imgWidth;
        var imgHeight;
        var coverScale;
        var renderWidth;
        var renderHeight;
        var offsetX;
        var offsetY;
        var rows = [];

        if (!image || !image.naturalWidth || !image.naturalHeight || !grid.isConnected) {
          clearSection(section);
          return;
        }

        sectionRect = section.getBoundingClientRect();

        if (!sectionRect.width || !sectionRect.height) {
          clearSection(section);
          return;
        }

        imgWidth = image.naturalWidth;
        imgHeight = image.naturalHeight;
        coverScale = Math.max(sectionRect.width / imgWidth, sectionRect.height / imgHeight);

        if (!isNaN(scale) && scale > 0) {
          coverScale *= scale;
        }

        renderWidth = imgWidth * coverScale;
        renderHeight = imgHeight * coverScale;
        offsetX = (sectionRect.width - renderWidth) * position.x;
        offsetY = (sectionRect.height - renderHeight) * position.y;

        links.forEach(function (link) {
          var rect = link.getBoundingClientRect();
          var left = rect.left - sectionRect.left;
          var top = rect.top - sectionRect.top;
          var row = rows[rows.length - 1];

          link.style.setProperty("--hp-slice-image", "url('" + imageUrl.replace(/'/g, "\\'") + "')");
          link.style.setProperty("--hp-slice-width", renderWidth + "px");
          link.style.setProperty("--hp-slice-height", renderHeight + "px");
          link.style.setProperty("--hp-slice-x", (offsetX - left) + "px");
          link.style.setProperty("--hp-slice-y", (offsetY - top) + "px");
          link.style.setProperty("--hp-slice-opacity", isNaN(opacity) ? ".32" : String(opacity));
          link.style.setProperty("--hp-slice-opacity-light", String(lightOpacity));
          link.style.setProperty("--hp-slice-filter", filter);

          if (!row || Math.abs(row.top - rect.top) > 4) {
            row = { top: rect.top, links: [] };
            rows.push(row);
          }

          row.links.push(link);
        });

        if (rows.length > 1 && rows[0].links.length > 1 && rows[rows.length - 1].links.length === 1) {
          var loneLink = rows[rows.length - 1].links[0];
          var sampleWidth = rows[0].links[0].getBoundingClientRect().width;

          loneLink.classList.add("is-hp-last-single");
          loneLink.style.setProperty("--hp-last-width", sampleWidth + "px");
        }

        section.setAttribute("data-hp-sliced", "true");
      });
    }

    function syncAllSlices() {
      document.querySelectorAll(".hp-game").forEach(applySlicesForSection);
    }

    function scheduleSync() {
      if (frame) {
        cancelAnimationFrame(frame);
      }

      frame = requestAnimationFrame(function () {
        frame = 0;
        syncAllSlices();
      });
    }

    window.__saydisSyncHomeProducts = scheduleSync;
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("load", scheduleSync);

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(scheduleSync);
      document.querySelectorAll(".hp-grid, #products .saydis-list-grid").forEach(function (node) {
        resizeObserver.observe(node);
      });
    }

    scheduleSync();
  }

  function initHomePage() {
    var body = getBody();
    var requested = getRequestedLanguage();
    var initial;

    if (!body || !body.classList.contains("home-root")) {
      return;
    }

    initial = requested === "en" || requested === "ru" ? requested : safeLocalGet("saydis:home-language") || "ru";
    setHomeLanguage(initial, { initial: true, skipHistory: !requested });

    var hpGameColors = {
      "apex.svg": ["229,82,38", "255,176,55"],
      "arc.svg": ["249,150,50", "255,217,112"],
      "cb.svg": ["192,49,42", "231,170,77"],
      "darktide.svg": ["61,158,131", "179,225,164"],
      "dune.svg": ["204,125,53", "239,196,112"],
      "eft.svg": ["118,131,88", "194,178,121"],
      "enshrouded.svg": ["210,122,51", "249,196,91"],
      "eve.svg": ["72,145,214", "153,205,255"],
      "hunt.svg": ["166,72,49", "225,146,83"],
      "lostark.svg": ["214,158,55", "255,221,126"],
      "marvel.svg": ["210,40,58", "255,120,130"],
      "nw.svg": ["55,140,182", "232,183,84"],
      "outlast.svg": ["183,47,55", "255,104,113"],
      "phasmophobia.svg": ["79,122,201", "141,204,255"],
      "poe.svg": ["183,94,45", "230,170,82"],
      "rust.svg": ["206,89,47", "255,158,82"],
      "rustkick.svg": ["51,171,91", "133,230,138"],
      "scum.svg": ["111,158,77", "205,222,112"],
      "sot.svg": ["35,164,153", "122,226,200"],
      "stalcraft.svg": ["190,64,133", "255,132,177"],
      "tal.svg": ["198,151,70", "111,159,214"],
      "tf.svg": ["235,172,42", "255,222,80"],
      "ufl.svg": ["69,179,79", "156,226,102"],
      "warframe.svg": ["148,20,196", "94,178,255"]
    };

    document.querySelectorAll("[data-hp-logo]").forEach(function (item) {
      var logo = item.getAttribute("data-hp-logo");
      var file = logo ? logo.split("/").pop().toLowerCase() : "";
      var colors = hpGameColors[file] || ["148,20,196", "179,98,255"];
      var title = item.querySelector("h3");

      if (logo) {
        item.style.setProperty("--hp-logo", "url('" + logo.replace(/'/g, "\\'") + "')");
      }

      item.style.setProperty("--hp-accent-rgb", colors[0]);
      item.style.setProperty("--hp-accent-2-rgb", colors[1]);

      if (title) {
        var words = title.textContent.trim().split(/\s+/);
        var longestWord = words.reduce(function (longest, word) {
          return word.length > longest ? word.length : longest;
        }, 0);

        if (title.textContent.trim().length > 17 || longestWord > 10) {
          item.setAttribute("data-hp-title", "long");
        }
      }
    });

    document.querySelectorAll("[data-home-lang]").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        setHomeLanguage(button.getAttribute("data-home-lang"));
      });
    });

    initHomeProductSlices();

    document.querySelectorAll(".saydis-hgc[href], .hp-link[href]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        var href;
        var target;

        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }

        href = link.getAttribute("href");

        if (!href || href.charAt(0) === "#" || /^(mailto|tel|javascript):/i.test(href)) {
          return;
        }

        if (window.location.protocol === "file:") {
          href = getLocalIndexHref(href, document.baseURI);
        }

        target = new URL(href, document.baseURI).href;
        event.preventDefault();
        window.location.assign(target);
      });
    });
  }

  function getSotItemName(card) {
    var title = card.querySelector(".saydis-copy strong");

    return title ? title.textContent.trim() : "";
  }

  function sotMatchesAny(name, patterns) {
    return patterns.some(function (pattern) {
      return pattern.test(name);
    });
  }

  function getSotCategory(name) {
    var otherPatterns = [
      /ship'?s crest/i,
      /\brug\b/i,
      /\bdrapes\b/i,
      /captain'?s bed/i,
      /captain'?s table/i,
      /cap'?s chandelier/i,
      /captain'?s chair/i,
      /\blogbook\b/i
    ];
    var rules = [
      ["Emotes", [/\bemote\b/i]],
      ["Gold", [/\bgold\b/i]],
      ["Title", [/\btitle\b/i]],
      ["Other", otherPatterns],
      ["Appearance", [/\bhair(?: \d+)?\b/i, /\bbeard\b/i]],
      ["Speaking Trumpet", [/\bspeaking trumpet\b/i]],
      ["Fishing Rod", [/\bfishing rod\b/i]],
      ["Pocket Watch", [/\bpocket watch\b/i]],
      ["Eye of Reach", [/\beye of reach\b/i]],
      ["Hurdy-Gurdy", [/\bhurdy[- ]?gurdy\b/i, /\bhurdygurdy\b/i]],
      ["Blunderbuss", [/\bblunder(?:buss|uss)\b/i]],
      ["Sails", [/\bsails\b/i]],
      ["Cannons", [/\bcannons?\b/i]],
      ["Wheel", [/\bship wheel\b/i, /\bwheel\b/i]],
      ["Capstan", [/\bcapstan\b/i]],
      ["Figurehead", [/\bfigurehead\b/i]],
      ["Hull", [/\bhull\b/i]],
      ["Flag", [/\bflag\b/i]],
      ["Pistol", [/\bflintlock pistol\b/i, /\bpistol\b/i]],
      ["Cutlass", [/\bcutlass\b/i, /\brapier\b/i, /\bsword\b/i]],
      ["Banjo", [/\bbanjo\b/i]],
      ["Concertina", [/\bconcertina\b/i]],
      ["Drum", [/\bdrum\b/i]],
      ["Bucket", [/\bbucket\b/i]],
      ["Compass", [/\bcompass\b/i]],
      ["Lantern", [/\blantern\b/i]],
      ["Shovel", [/\bshovel\b/i]],
      ["Spyglass", [/\bspyglass\b/i]],
      ["Tankard", [/\btankard\b/i]],
      ["Pegleg", [/\bpeg ?leg\b/i, /\bpegleg\b/i]],
      ["Hat", [/\bhat\b/i]],
      ["Eyepatch", [/\beyepatch\b/i]],
      ["Trousers", [/\btrousers\b/i]],
      ["Hook", [/\bhook\b/i]],
      ["Jacket", [/\bjacket\b/i]],
      ["Boots", [/\bboots\b/i]],
      ["Gloves", [/\bgloves\b/i]],
      ["Belt", [/\bbelt\b/i]],
      ["Dress", [/\bdress\b/i]],
      ["Shirt", [/\bshirt\b/i]]
    ];
    var i;

    for (i = 0; i < rules.length; i += 1) {
      if (sotMatchesAny(name, rules[i][1])) {
        return rules[i][0];
      }
    }

    return "Other";
  }

  function createSiteElement(tag, className, text) {
    var element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (text) {
      element.textContent = text;
    }

    return element;
  }

  function getSotTypeRank(name) {
    if (/\bhull\b/i.test(name)) { return 10; }
    if (/\bsails\b/i.test(name)) { return 20; }
    if (/\bfigurehead\b/i.test(name)) { return 30; }
    if (/\b(ship wheel|wheel)\b/i.test(name)) { return 40; }
    if (/\bflag\b/i.test(name)) { return 50; }
    if (/\bcannons?\b/i.test(name)) { return 60; }
    if (/\bcapstan\b/i.test(name)) { return 70; }
    if (/\bhat\b/i.test(name)) { return 110; }
    if (/\bjacket\b/i.test(name)) { return 120; }
    if (/\bboots\b/i.test(name)) { return 130; }
    if (/\bgloves\b/i.test(name)) { return 140; }
    if (/\bbelt\b/i.test(name)) { return 150; }
    if (/\btrousers\b/i.test(name)) { return 160; }
    if (/\bdress\b/i.test(name)) { return 170; }
    if (/\bshirt\b/i.test(name)) { return 180; }
    if (/\bhook\b/i.test(name)) { return 190; }
    if (/\bpeg ?leg\b|\bpegleg\b/i.test(name)) { return 200; }
    if (/\beyepatch\b/i.test(name)) { return 210; }
    if (/\bhair(?: \d+)?\b|\bbeard\b/i.test(name)) { return 220; }
    if (/\bpistol\b|\bflintlock pistol\b/i.test(name)) { return 310; }
    if (/\bblunder(?:buss|uss)\b/i.test(name)) { return 320; }
    if (/\beye of reach\b/i.test(name)) { return 330; }
    if (/\bcutlass\b|\brapier\b|\bsword\b/i.test(name)) { return 340; }
    if (/\bspeaking trumpet\b/i.test(name)) { return 410; }
    if (/\bfishing rod\b/i.test(name)) { return 420; }
    if (/\bpocket watch\b/i.test(name)) { return 430; }
    if (/\bhurdy[- ]?gurdy\b|\bhurdygurdy\b/i.test(name)) { return 440; }
    if (/\bbanjo\b/i.test(name)) { return 450; }
    if (/\bconcertina\b/i.test(name)) { return 460; }
    if (/\bdrum\b/i.test(name)) { return 470; }
    if (/\bbucket\b/i.test(name)) { return 480; }
    if (/\bcompass\b/i.test(name)) { return 490; }
    if (/\blantern\b/i.test(name)) { return 500; }
    if (/\bshovel\b/i.test(name)) { return 510; }
    if (/\bspyglass\b/i.test(name)) { return 520; }
    if (/\btankard\b/i.test(name)) { return 530; }
    if (/\btitle\b/i.test(name)) { return 610; }

    return 900;
  }

  function getSotCollectionName(name) {
    var collection = name.replace(/\s+/g, " ").trim();
    var sailorMatch = collection.match(/^\S+\s+Sailor\b/i);
    var stripPatterns = [
      /\s+battle hat$/i,
      /\s+dress hat$/i,
      /\s+crew jacket$/i,
      /\s+dress jacket$/i,
      /\s+crew gloves$/i,
      /\s+captain gloves$/i,
      /\s+captain'?s chandelier$/i,
      /\s+captain'?s table$/i,
      /\s+captain'?s chair$/i,
      /\s+captain'?s bed$/i,
      /\s+speaking trumpet$/i,
      /\s+flintlock pistol$/i,
      /\s+fishing rod$/i,
      /\s+pocket watch$/i,
      /\s+eye of reach$/i,
      /\s+ship'?s crest$/i,
      /\s+heavy sword$/i,
      /\s+cap'?s chandelier$/i,
      /\s+hurdy[- ]?gurdy$/i,
      /\s+blunder(?:buss|uss)$/i,
      /\s+figurehead$/i,
      /\s+ship wheel$/i,
      /\s+cannons?$/i,
      /\s+capstan$/i,
      /\s+cutlass$/i,
      /\s+rapier$/i,
      /\s+sword$/i,
      /\s+sails$/i,
      /\s+hull$/i,
      /\s+flag$/i,
      /\s+wheel$/i,
      /\s+pistol$/i,
      /\s+banjo$/i,
      /\s+concertina$/i,
      /\s+drum$/i,
      /\s+bucket$/i,
      /\s+compass$/i,
      /\s+lantern$/i,
      /\s+shovel$/i,
      /\s+spyglass$/i,
      /\s+tankard$/i,
      /\s+peg ?leg$/i,
      /\s+pegleg$/i,
      /\s+eyepatch$/i,
      /\s+trousers$/i,
      /\s+jacket$/i,
      /\s+gloves$/i,
      /\s+boots$/i,
      /\s+belt$/i,
      /\s+dress$/i,
      /\s+shirt$/i,
      /\s+hook$/i,
      /\s+hat$/i,
      /\s+beard$/i,
      /\s+hair(?: \d+)?$/i,
      /\s+pirate title$/i,
      /\s+title$/i,
      /\s+rug$/i,
      /\s+drapes$/i,
      /\s+logbook$/i
    ];
    var i;

    if (/\bemote\b/i.test(collection) || /\bgold\b/i.test(collection)) {
      return "";
    }

    if (sailorMatch) {
      return "Sailor";
    }

    for (i = 0; i < stripPatterns.length; i += 1) {
      collection = collection.replace(stripPatterns[i], "").trim();
    }

    if (/^(onyx|ebon)$/i.test(collection)) {
      return "Obsidian";
    }

    return collection;
  }

  function findSotBaseCollection(collection, collectionMap) {
    var collectionKey = collection.toLowerCase();
    var best = "";

    Object.keys(collectionMap).forEach(function (key) {
      var title = collectionMap[key].title;

      if (key === collectionKey || collectionMap[key].cards.length < 2) {
        return;
      }

      if (collectionKey.indexOf(key + " ") === 0 && key.length > best.length) {
        best = title;
      }
    });

    return best;
  }

  function mergeSotAutoSubCollections(collectionMap) {
    var keys = Object.keys(collectionMap);

    keys.forEach(function (key) {
      var entry = collectionMap[key];
      var baseTitle = findSotBaseCollection(entry.title, collectionMap);
      var baseKey;

      if (!baseTitle) {
        return;
      }

      baseKey = baseTitle.toLowerCase();

      if (!collectionMap[baseKey] || collectionMap[baseKey] === entry) {
        return;
      }

      entry.cards.forEach(function (card) {
        collectionMap[baseKey].cards.push(card);
      });

      collectionMap[baseKey].firstIndex = Math.min(collectionMap[baseKey].firstIndex, entry.firstIndex);
      delete collectionMap[key];
    });
  }

  function sortSotCardsByType(cards) {
    return cards.slice().sort(function (a, b) {
      var aName = getSotItemName(a);
      var bName = getSotItemName(b);
      var aRank = getSotTypeRank(aName);
      var bRank = getSotTypeRank(bName);

      if (aRank !== bRank) {
        return aRank - bRank;
      }

      return (parseInt(a.getAttribute("data-sot-source-index"), 10) || 0) - (parseInt(b.getAttribute("data-sot-source-index"), 10) || 0);
    });
  }

  function getSotGoldTotal(cards) {
    var total = 0;

    cards.forEach(function (card) {
      var name = getSotItemName(card);
      var amountMatch = name.replace(/,/g, "").match(/(\d+)\s*Gold/i);

      if (!amountMatch) {
        return;
      }

      total += (parseInt(amountMatch[1], 10) || 0) * getCatalogCardAmount(card);
    });

    return total;
  }

  function formatSotGoldTitle(total) {
    if (!total) {
      return "Gold";
    }

    return String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " Gold";
  }

  function createSotAutoSetSection(entry, index) {
    var section = createSiteElement("section", "saydis-list-section");
    var aside = document.createElement("aside");
    var title = createSiteElement("h2", "", entry.title);
    var counter = createSiteElement("span", "saydis-section-count");
    var grid = createSiteElement("div", "saydis-list-grid");

    section.id = "auto-" + String(index + 1).padStart(2, "0");
    aside.appendChild(title);
    aside.appendChild(counter);
    section.appendChild(aside);
    section.appendChild(grid);

    sortSotCardsByType(entry.cards).forEach(function (card) {
      grid.appendChild(card);
    });

    return section;
  }

  function sortSotAutoSetEntries(entries) {
    return entries.sort(function (a, b) {
      if (a.bottom !== b.bottom) {
        return a.bottom - b.bottom;
      }

      return a.firstIndex - b.firstIndex;
    });
  }

  function initSotAutoSets() {
    var body = getBody();
    var main = document.querySelector(".saydis-main");
    var source = document.querySelector("[data-sot-auto-source]");
    var cards;
    var collectionMap = {};
    var otherCards = [];
    var emoteCards = [];
    var goldCards = [];
    var entries = [];
    var sourceMarker;

    if (!body || !body.hasAttribute("data-sot-auto-sets") || !main || !source) {
      return;
    }

    cards = Array.prototype.slice.call(source.querySelectorAll(".saydis-card"));

    if (!cards.length) {
      return;
    }

    cards.forEach(function (card, index) {
      var name = getSotItemName(card);
      var collection;
      var key;

      card.setAttribute("data-sot-source-index", String(index));

      if (/\bemote\b/i.test(name)) {
        emoteCards.push(card);
        return;
      }

      if (/\bgold\b/i.test(name)) {
        goldCards.push(card);
        return;
      }

      collection = getSotCollectionName(name);

      if (!collection) {
        otherCards.push(card);
        return;
      }

      key = collection.toLowerCase();

      if (!collectionMap[key]) {
        collectionMap[key] = {
          title: collection,
          cards: [],
          firstIndex: index
        };
      }

      collectionMap[key].cards.push(card);
    });

    mergeSotAutoSubCollections(collectionMap);

    Object.keys(collectionMap).forEach(function (key) {
      var entry = collectionMap[key];

      if (entry.cards.length > 1) {
        entries.push({
          title: entry.title,
          cards: entry.cards,
          firstIndex: entry.firstIndex,
          bottom: 1
        });
        return;
      }

      otherCards.push(entry.cards[0]);
    });

    if (otherCards.length) {
      entries.push({
        title: "Other Skins",
        cards: otherCards,
        firstIndex: 1000000,
        bottom: 10
      });
    }

    if (emoteCards.length) {
      entries.push({
        title: "Emotes",
        cards: emoteCards,
        firstIndex: 1000001,
        bottom: 11
      });
    }

    if (goldCards.length) {
      entries.push({
        title: formatSotGoldTitle(getSotGoldTotal(goldCards)),
        cards: goldCards,
        firstIndex: 1000002,
        bottom: 12
      });
    }

    sortSotAutoSetEntries(entries);
    source.hidden = true;
    sourceMarker = source.nextSibling;

    entries.forEach(function (entry, index) {
      main.insertBefore(createSotAutoSetSection(entry, index), sourceMarker);
    });
  }

  function getSotDisplayTitle(category, section) {
    var title = section ? section.querySelector("aside h2") : null;
    var titleText = title ? title.textContent.trim() : "";

    if (category === "Gold" && /\bgold\b/i.test(titleText)) {
      return titleText;
    }

    return category;
  }

  function createSotSortSwitch() {
    var body = getBody();
    var switcher = createSiteElement("div", "sot-sort-switch");
    var title = createSiteElement("span", "sot-sort-title", "Sort items");
    var buttons = createSiteElement("div", "inst-lang-card__native sot-sort-buttons");
    var setButton = createSiteElement("button", "active", "By set");
    var typeButton = createSiteElement("button", "", "By item type");
    var searchSlot;
    var searchButton;
    var searchInput;

    switcher.setAttribute("data-sot-sort-switch", "");
    setButton.type = "button";
    setButton.setAttribute("data-sot-view", "set");
    typeButton.type = "button";
    typeButton.setAttribute("data-sot-view", "type");
    buttons.appendChild(setButton);
    buttons.appendChild(typeButton);

    if (body && body.hasAttribute("data-sot-auto-sets")) {
      searchSlot = createSiteElement("div", "sot-sort-search-slot");
      searchButton = createSiteElement("button", "sot-sort-search-toggle", "Search");
      searchInput = document.createElement("input");

      searchSlot.setAttribute("data-sot-search", "");
      searchButton.type = "button";
      searchButton.setAttribute("data-sot-search-toggle", "");
      searchButton.setAttribute("aria-expanded", "false");
      searchInput.className = "sot-sort-search-input";
      searchInput.type = "search";
      searchInput.autocomplete = "off";
      searchInput.spellcheck = false;
      searchInput.placeholder = "Search";
      searchInput.setAttribute("aria-label", "Search rewards on page");
      searchInput.setAttribute("data-sot-search-input", "");
      searchSlot.appendChild(searchButton);
      searchSlot.appendChild(searchInput);
      buttons.appendChild(searchSlot);
    }

    switcher.appendChild(title);
    switcher.appendChild(buttons);

    return switcher;
  }

  function createSotTypeSection(entry, index) {
    var section = createSiteElement("section", "saydis-list-section sot-type-section");
    var aside = document.createElement("aside");
    var title = createSiteElement("h2", "", entry.displayTitle || entry.category);
    var counter = createSiteElement("span", "saydis-section-count");
    var grid = createSiteElement("div", "saydis-list-grid");

    section.id = "type-" + String(index + 1).padStart(2, "0");
    counter.innerHTML = "<b>" + entry.count + "</b><em>" + getCountLabel(entry.count, "item", "items") + "</em>";
    aside.appendChild(title);
    aside.appendChild(counter);
    section.appendChild(aside);
    section.appendChild(grid);

    return {
      category: entry.category,
      section: section,
      grid: grid
    };
  }

  function sortSotCategoryEntries(entries) {
    var bottomOrder = {
      Title: 1,
      Other: 2,
      Emotes: 3,
      Gold: 4
    };
    var shipParts = {
      Sails: true,
      Hull: true,
      Flag: true,
      Wheel: true,
      Capstan: true,
      Cannons: true,
      Figurehead: true
    };
    var clothing = {
      Hat: true,
      Jacket: true,
      Boots: true,
      Gloves: true,
      Belt: true,
      Trousers: true,
      Dress: true,
      Shirt: true,
      Hook: true,
      Pegleg: true,
      Eyepatch: true,
      Appearance: true
    };
    var weapons = {
      Pistol: true,
      Blunderbuss: true,
      "Eye of Reach": true,
      Cutlass: true
    };

    function groupOrder(category) {
      if (bottomOrder[category]) {
        return 10 + bottomOrder[category];
      }

      if (shipParts[category]) {
        return 1;
      }

      if (clothing[category]) {
        return 2;
      }

      if (weapons[category]) {
        return 3;
      }

      return 4;
    }

    return entries.sort(function (a, b) {
      var aGroup = groupOrder(a.category);
      var bGroup = groupOrder(b.category);

      if (aGroup !== bGroup) {
        return aGroup - bGroup;
      }

      if (aGroup < 10 && b.count !== a.count) {
        return b.count - a.count;
      }

      return a.category.localeCompare(b.category);
    });
  }

  function initSotSort() {
    var body = getBody();
    var main = document.querySelector(".saydis-main");
    var header = document.querySelector(".saydis-hero");
    var switcher;
    var sourceSections;
    var sourceRecords;
    var categoryMap = {};
    var categoryCounts = {};
    var categoryTitles = {};
    var categoryEntries;
    var typeRoot;
    var typeSections;
    var buttons;

    if (!body || !body.classList.contains("skin-sot") || body.classList.contains("inst-page") || !main || !header) {
      return;
    }

    sourceSections = Array.prototype.filter.call(main.children, function (child) {
      return child.classList && child.classList.contains("saydis-list-section") && !child.classList.contains("sot-type-section");
    });

    if (!sourceSections.length) {
      return;
    }

    switcher = document.querySelector("[data-sot-sort-switch]");

    if (!switcher) {
      switcher = createSotSortSwitch();
      header.insertAdjacentElement("afterend", switcher);
    }

    if (switcher.hasAttribute("data-sot-sort-ready")) {
      return;
    }

    switcher.setAttribute("data-sot-sort-ready", "");
    switcher.setAttribute("data-sot-current-view", "set");

    sourceRecords = sourceSections.map(function (section) {
      var grid = section.querySelector(".saydis-list-grid");
      var titleNode = section.querySelector("aside h2");
      var cards = grid ? Array.prototype.filter.call(grid.children, function (child) {
        return child.classList && child.classList.contains("saydis-card");
      }) : [];

      cards.forEach(function (card) {
        var category = getSotCategory(getSotItemName(card));

        if (!categoryMap[category]) {
          categoryMap[category] = [];
          categoryCounts[category] = 0;
        }

        if (!categoryTitles[category]) {
          categoryTitles[category] = getSotDisplayTitle(category, section);
        }

        categoryMap[category].push(card);
        categoryCounts[category] += getCatalogCardAmount(card);
      });

      return {
        title: titleNode ? titleNode.textContent.trim() : "",
        section: section,
        grid: grid,
        cards: cards
      };
    });

    categoryEntries = Object.keys(categoryMap).map(function (category) {
      return {
        category: category,
        displayTitle: categoryTitles[category] || category,
        cards: categoryMap[category],
        count: categoryCounts[category]
      };
    });

    sortSotCategoryEntries(categoryEntries);
    typeRoot = createSiteElement("div", "sot-type-view");
    typeRoot.hidden = true;
    typeSections = categoryEntries.map(function (entry, index) {
      var typeSection = createSotTypeSection(entry, index);

      typeRoot.appendChild(typeSection.section);

      return {
        category: entry.category,
        cards: entry.cards,
        section: typeSection.section,
        grid: typeSection.grid
      };
    });

    main.appendChild(typeRoot);
    buttons = Array.prototype.slice.call(switcher.querySelectorAll("[data-sot-view]"));

    function setButtons(view) {
      switcher.setAttribute("data-sot-current-view", view);
      buttons.forEach(function (button) {
        button.classList.toggle("active", button.getAttribute("data-sot-view") === view);
      });
    }

    function showSetView() {
      sourceRecords.forEach(function (record) {
        record.section.hidden = false;
        record.section.classList.remove("sot-set-view-hidden");
        record.cards.forEach(function (card) {
          record.grid.appendChild(card);
        });
      });

      typeRoot.hidden = true;
      setButtons("set");
    }

    function showTypeView() {
      typeSections.forEach(function (record) {
        record.cards.forEach(function (card) {
          record.grid.appendChild(card);
        });
      });

      sourceRecords.forEach(function (record) {
        record.section.hidden = true;
        record.section.classList.add("sot-set-view-hidden");
      });

      typeRoot.hidden = false;
      setButtons("type");
    }

    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.getAttribute("data-sot-view") === "type") {
          showTypeView();
          return;
        }

        showSetView();
      });
    });

    switcher._sotSourceRecords = sourceRecords;
    switcher._sotTypeSections = typeSections;
    switcher._sotShowSetView = showSetView;
    switcher._sotShowTypeView = showTypeView;
  }

  function buildSotDemoSearchResult(items, typeSections, collectionRecords, query) {
    var normalized = (query || "").trim().toLowerCase();
    var compactNormalized = normalized.replace(/[^a-z0-9]+/g, "");
    var result = {
      query: (query || "").trim(),
      normalized: normalized,
      matchedTypeSections: [],
      matchedCollections: [],
      directItems: []
    };
    var matchedCategories = {};
    var matchedCollectionKeys = {};

    if (!normalized) {
      return result;
    }

    typeSections.forEach(function (record) {
      var titleNode = record.section.querySelector("aside h2");
      var titleText = titleNode ? titleNode.textContent.trim().toLowerCase() : record.category.toLowerCase();

      if (titleText.indexOf(normalized) === -1 && record.category.toLowerCase().indexOf(normalized) === -1) {
        return;
      }

      matchedCategories[record.category] = true;
      result.matchedTypeSections.push(record);
    });

    collectionRecords.forEach(function (record) {
      var isDirectTitleMatch = record.titleLower.indexOf(normalized) !== -1;
      var isAliasMatch = compactNormalized.length > 1 && record.searchTokens.some(function (token) {
        return token.indexOf(compactNormalized) === 0;
      });

      if (!isDirectTitleMatch && !isAliasMatch) {
        return;
      }

      matchedCollectionKeys[record.key] = true;
      result.matchedCollections.push(record);
    });

    items.forEach(function (item) {
      if (item.nameLower.indexOf(normalized) === -1) {
        return;
      }

      if (matchedCategories[item.category] || matchedCollectionKeys[item.collectionKey]) {
        return;
      }

      result.directItems.push(item);
    });

    return result;
  }

  function initSotDemo() {
    var body = getBody();
    var main = document.querySelector(".saydis-main");
    var switcher = document.querySelector("[data-sot-sort-switch]");
    var sourceRecords = switcher ? switcher._sotSourceRecords || [] : [];
    var typeSections = switcher ? switcher._sotTypeSections || [] : [];
    var typeRoot = main ? main.querySelector(".sot-type-view") : null;
    var sadImagePaths = [
      "../../images/home/sad.jpg",
      "../../images/home/sad2.jpg",
      "../../images/home/sad3.webp",
      "../../images/home/sad4.jpg"
    ];
    var collectionMap = {};
    var collectionRecords;
    var collectionKeyByCardId = {};
    var items;
    var searchRoot;
    var searchToggle;
    var searchInput;
    var searchView;
    var emptyState;
    var emptyStateImage;
    var state;

    if (!body || !body.hasAttribute("data-sot-auto-sets") || !body.classList.contains("skin-sot") || body.classList.contains("inst-page") || !main || !switcher) {
      return;
    }

    searchRoot = switcher.querySelector("[data-sot-search]");
    searchToggle = switcher.querySelector("[data-sot-search-toggle]");
    searchInput = switcher.querySelector("[data-sot-search-input]");

    if (!searchRoot || !searchToggle || !searchInput || searchRoot.hasAttribute("data-sot-search-ready")) {
      return;
    }

    searchRoot.setAttribute("data-sot-search-ready", "");

    items = Array.prototype.slice.call(main.querySelectorAll(".saydis-card")).map(function (card) {
      var name = getSotItemName(card);
      var category = getSotCategory(name);
      var collection = getSotCollectionName(name);
      var sourceSection = sourceRecords.find(function (record) {
        return record.cards.indexOf(card) !== -1;
      });
      var sourceIndex = parseInt(card.getAttribute("data-sot-source-index"), 10);

      card._sotSearchId = String(sourceIndex || 0) + ":" + String(Math.random()).slice(2);
      return {
        card: card,
        name: name,
        nameLower: name.toLowerCase(),
        category: category,
        collection: collection,
        sourceTitle: sourceSection ? sourceSection.title : "",
        sourceIndex: isNaN(sourceIndex) ? 0 : sourceIndex
      };
    });

    if (!items.length) {
      return;
    }

    items.forEach(function (item, index) {
      var key;

      if (!item.collection) {
        item.collectionKey = "";
        item.searchOrder = item.sourceIndex || index;
        return;
      }

      key = item.collection.toLowerCase();

      if (!collectionMap[key]) {
        collectionMap[key] = {
          title: item.collection,
          cards: [],
          firstIndex: item.sourceIndex || index
        };
      }

      collectionMap[key].cards.push(item.card);
      collectionMap[key].firstIndex = Math.min(collectionMap[key].firstIndex, item.sourceIndex || index);
    });

    mergeSotAutoSubCollections(collectionMap);

    collectionRecords = Object.keys(collectionMap).map(function (key) {
      var words = collectionMap[key].title.toLowerCase().match(/[a-z0-9]+/g) || [];
      var initials = words.map(function (word) {
        return word.charAt(0);
      }).join("");
      var compactTitle = words.join("");
      var searchTokens = [];

      if (compactTitle) {
        searchTokens.push(compactTitle);
      }

      if (initials.length > 1) {
        searchTokens.push(initials);
        searchTokens.push(initials + "s");
      }

      return {
        key: key,
        title: collectionMap[key].title,
        titleLower: collectionMap[key].title.toLowerCase(),
        cards: collectionMap[key].cards.slice(),
        firstIndex: collectionMap[key].firstIndex,
        searchTokens: searchTokens
      };
    }).sort(function (a, b) {
      if (a.firstIndex !== b.firstIndex) {
        return a.firstIndex - b.firstIndex;
      }

      return a.title.localeCompare(b.title);
    });

    collectionRecords.forEach(function (record) {
      record.cards.forEach(function (card) {
        collectionKeyByCardId[card._sotSearchId] = record.key;
      });
    });

    items.forEach(function (item, index) {
      item.collectionKey = collectionKeyByCardId[item.card._sotSearchId] || (item.collection ? item.collection.toLowerCase() : "");
      item.searchOrder = item.sourceIndex || index;
    });

    searchView = createSiteElement("div", "sot-search-view");
    searchView.hidden = true;
    main.insertBefore(searchView, typeRoot || main.firstChild);
    emptyState = createSiteElement("section", "sot-search-empty");
    emptyState.hidden = true;
    emptyStateImage = document.createElement("img");
    emptyStateImage.alt = "No matches";
    emptyStateImage.decoding = "async";
    emptyStateImage.setAttribute("src", sadImagePaths[Math.floor(Math.random() * sadImagePaths.length)]);
    emptyState.appendChild(emptyStateImage);
    main.insertBefore(emptyState, searchView);

    state = {
      open: false,
      query: "",
      manualView: switcher.getAttribute("data-sot-current-view") || "set"
    };

    function syncSearchUi() {
      var hasQuery = !!(state.query || "").trim();
      var isOpen = state.open || hasQuery;
      var queryLength = (state.query || "").length;

      searchRoot.classList.toggle("is-open", isOpen);
      searchRoot.classList.toggle("has-query", hasQuery);
      searchRoot.classList.toggle("is-long-query", queryLength > 7);
      searchToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    function setSearchOpen(isOpen, shouldFocus, selectText) {
      state.open = !!isOpen;
      syncSearchUi();

      if ((state.open || (state.query || "").trim()) && shouldFocus) {
        window.requestAnimationFrame(function () {
          searchInput.focus();

          if (selectText) {
            searchInput.select();
          }
        });
      }
    }

    function resetSearchVisibility() {
      items.forEach(function (item) {
        item.card.hidden = false;
        item.card.classList.remove("sot-search-match");
      });

      sourceRecords.forEach(function (record) {
        record.section.hidden = false;
        record.section.classList.remove("sot-demo-section-empty");
      });

      typeSections.forEach(function (record) {
        record.section.classList.remove("sot-demo-section-empty");
      });

      searchView.hidden = true;
      searchView.textContent = "";
      emptyState.hidden = true;
    }

    function setRandomEmptyStateImage() {
      var currentPath = emptyStateImage.getAttribute("src") || "";
      var nextPath = sadImagePaths[Math.floor(Math.random() * sadImagePaths.length)];

      if (sadImagePaths.length > 1) {
        while (nextPath === currentPath) {
          nextPath = sadImagePaths[Math.floor(Math.random() * sadImagePaths.length)];
        }
      }

      emptyStateImage.setAttribute("src", nextPath);
    }

    function createSotSearchSection(title, cards, sectionClassName, index, shouldSortByType) {
      var section = createSiteElement("section", "saydis-list-section" + (sectionClassName ? " " + sectionClassName : ""));
      var aside = document.createElement("aside");
      var titleNode = createSiteElement("h2", "", title);
      var counter = createSiteElement("span", "saydis-section-count");
      var grid = createSiteElement("div", "saydis-list-grid");
      var orderedCards = shouldSortByType ? sortSotCardsByType(cards) : cards.slice();
      var count = 0;

      section.id = "search-" + String(index + 1).padStart(2, "0");

      orderedCards.forEach(function (card) {
        var clone = card.cloneNode(true);

        clone.classList.add("sot-search-match");
        grid.appendChild(clone);
        count += getCatalogCardAmount(card);
      });

      counter.innerHTML = "<b>" + count + "</b><em>" + getCountLabel(count, "item", "items") + "</em>";
      aside.appendChild(titleNode);
      aside.appendChild(counter);
      section.appendChild(aside);
      section.appendChild(grid);

      return section;
    }

    function renderSearchResults(queryResult) {
      var sectionIndex = 0;
      var hasAnyVisible = false;
      var directCards = queryResult.directItems.slice().sort(function (a, b) {
        return a.searchOrder - b.searchOrder;
      }).map(function (item) {
        return item.card;
      });

      if (typeof switcher._sotShowTypeView === "function") {
        switcher._sotShowTypeView();
      }

      if (typeRoot) {
        typeRoot.hidden = true;
      }

      searchView.textContent = "";

      queryResult.matchedTypeSections.forEach(function (record) {
        var titleNode = record.section.querySelector("aside h2");
        var titleText = titleNode ? titleNode.textContent.trim() : record.category;

        searchView.appendChild(createSotSearchSection(titleText, record.cards, "sot-type-section", sectionIndex, false));
        sectionIndex += 1;
        hasAnyVisible = true;
      });

      queryResult.matchedCollections.forEach(function (record) {
        searchView.appendChild(createSotSearchSection(record.title, record.cards, "", sectionIndex, true));
        sectionIndex += 1;
        hasAnyVisible = true;
      });

      if (directCards.length) {
        searchView.appendChild(createSotSearchSection("Matching items", directCards, "sot-search-direct-section", sectionIndex, false));
        hasAnyVisible = true;
      }

      searchView.hidden = !hasAnyVisible;

      if (!hasAnyVisible && emptyState.hidden) {
        setRandomEmptyStateImage();
      }

      emptyState.hidden = hasAnyVisible;
    }

    function applyState() {
      var queryResult = buildSotDemoSearchResult(items, typeSections, collectionRecords, state.query);
      var hasQuery = !!queryResult.normalized;

      if (!hasQuery) {
        resetSearchVisibility();

        if (state.open || state.manualView === "type") {
          if (typeof switcher._sotShowTypeView === "function") {
            switcher._sotShowTypeView();
          }
        } else if (typeof switcher._sotShowSetView === "function") {
          switcher._sotShowSetView();
        }
      } else {
        renderSearchResults(queryResult);
      }

      syncSearchUi();
    }

    searchToggle.addEventListener("click", function () {
      state.manualView = "type";
      state.open = true;
      applyState();
      setSearchOpen(true, true, false);
    });

    searchInput.addEventListener("focus", function () {
      setSearchOpen(true, false, false);
    });

    searchInput.addEventListener("input", function () {
      state.query = searchInput.value || "";

      if (state.query.trim()) {
        state.open = true;
      }

      applyState();
    });

    searchInput.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") {
        return;
      }

      if ((state.query || "").trim()) {
        searchInput.value = "";
        state.query = "";
        applyState();
        return;
      }

      setSearchOpen(false, false, false);
      searchToggle.focus();
    });

    searchInput.addEventListener("blur", function () {
      window.setTimeout(function () {
        if ((state.query || "").trim()) {
          return;
        }

        if (searchRoot.contains(document.activeElement)) {
          return;
        }

        setSearchOpen(false, false, false);
      }, 0);
    });

    switcher.addEventListener("click", function (event) {
      var viewButton = event.target.closest("[data-sot-view]");

      if (!viewButton) {
        return;
      }

      if (state.query.trim() || state.open) {
        searchInput.value = "";
        state.query = "";
        state.open = false;
      }

      state.manualView = viewButton.getAttribute("data-sot-view") || state.manualView;
      window.requestAnimationFrame(applyState);
    });

    document.addEventListener("click", function (event) {
      if (!state.open || switcher.contains(event.target)) {
        return;
      }

      setSearchOpen(false, false, false);
    });

    applyState();
  }

  function randomMetricsToken(length) {
    var alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var token = "";
    var cryptoApi = window.crypto || window.msCrypto;
    var values;
    var index;

    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      values = new Uint8Array(length);
      cryptoApi.getRandomValues(values);

      for (index = 0; index < values.length; index += 1) {
        token += alphabet.charAt(values[index] % alphabet.length);
      }

      return token;
    }

    while (token.length < length) {
      token += Math.random().toString(36).slice(2);
    }

    return token.slice(0, length);
  }

  function getMetricsClientId() {
    var storageKey = "saydis:metrics:cid";
    var existing = safeLocalGet(storageKey);
    var nextValue;

    if (existing) {
      return existing;
    }

    nextValue = "m" + randomMetricsToken(20);
    safeLocalSet(storageKey, nextValue);
    return nextValue;
  }

  function getMetricsSessionId() {
    var storageKey = "saydis:metrics:sid";
    var existing = safeSessionGet(storageKey);
    var nextValue;

    if (existing) {
      return existing;
    }

    nextValue = "s" + randomMetricsToken(18);
    safeSessionSet(storageKey, nextValue);
    return nextValue;
  }

  function getMetricsParam(name) {
    var params;

    try {
      params = new URLSearchParams(window.location.search || "");
      return params.get(name) || "";
    } catch (error) {
      return "";
    }
  }

  function shouldTrackSiteMetrics() {
    var body = getBody();
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;

    if (window.location.protocol === "file:" || navigator.webdriver) {
      return false;
    }

    if (window.location.pathname.indexOf("/metrics/") === 0) {
      return false;
    }

    if (body && body.hasAttribute("data-site-metrics-disabled")) {
      return false;
    }

    if (document.documentElement.hasAttribute("data-site-metrics-disabled")) {
      return false;
    }

    if (dnt === "1" || dnt === "yes") {
      return false;
    }

    return true;
  }

  function buildSiteMetricsPayload() {
    var timezone = "";

    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (error) {
      timezone = "";
    }

    return {
      path: window.location.pathname || "/",
      title: document.title || "",
      referrer: document.referrer || "",
      cid: getMetricsClientId(),
      sid: getMetricsSessionId(),
      utm_source: getMetricsParam("utm_source"),
      utm_medium: getMetricsParam("utm_medium"),
      utm_campaign: getMetricsParam("utm_campaign"),
      utm_term: getMetricsParam("utm_term"),
      utm_content: getMetricsParam("utm_content"),
      language: document.documentElement.getAttribute("lang") || navigator.language || "",
      timezone: timezone,
      viewport: {
        w: window.innerWidth || 0,
        h: window.innerHeight || 0
      },
      screen: {
        w: window.screen ? window.screen.width || 0 : 0,
        h: window.screen ? window.screen.height || 0 : 0
      }
    };
  }

  function clampMetricNumber(value, min, max) {
    value = Number(value) || 0;
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  function metricSectionLabel(node, index) {
    var label = "";
    var title;

    if (!node) {
      return "Block " + (index + 1);
    }

    title = node.querySelector("h1, h2, h3, .saydis-round-title, .saydis-section-title, aside strong, aside h2");
    if (title) {
      label = title.textContent || "";
    }
    if (!label) {
      label = node.getAttribute("aria-label") || node.getAttribute("data-title") || node.id || "";
    }
    label = String(label).replace(/\s+/g, " ").trim();
    return label || "Block " + (index + 1);
  }

  function collectMetricSections() {
    var selector = [
      "main > section",
      ".wrapper > section",
      ".saydis-list-section",
      ".seva-list-section",
      ".inst-panel",
      ".inst-alert",
      ".saydis-hero",
      ".saydis-related",
      "footer"
    ].join(",");
    var seen = [];
    var items = [];

    document.querySelectorAll(selector).forEach(function (node) {
      var rect;
      var id;

      if (!node || seen.indexOf(node) >= 0) {
        return;
      }
      rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return;
      }
      seen.push(node);
      id = node.id || node.getAttribute("data-site-section") || "";
      items.push({
        node: node,
        id: String(id || "block-" + (items.length + 1)),
        label: metricSectionLabel(node, items.length),
        visibleMs: 0,
        maxVisiblePercent: 0,
        activeSince: 0
      });
    });

    return items;
  }

  function sectionVisiblePercent(node) {
    var rect = node.getBoundingClientRect();
    var viewportH = window.innerHeight || document.documentElement.clientHeight || 1;
    var visibleTop = Math.max(rect.top, 0);
    var visibleBottom = Math.min(rect.bottom, viewportH);
    var visible = Math.max(0, visibleBottom - visibleTop);

    if (!rect.height) {
      return 0;
    }

    return clampMetricNumber((visible / rect.height) * 100, 0, 100);
  }

  function maxScrollPercent() {
    var doc = document.documentElement;
    var body = document.body;
    var viewportH = window.innerHeight || doc.clientHeight || 1;
    var scrollTop = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
    var height = Math.max(
      body.scrollHeight || 0,
      doc.scrollHeight || 0,
      body.offsetHeight || 0,
      doc.offsetHeight || 0,
      body.clientHeight || 0,
      doc.clientHeight || 0
    );
    var scrollable = Math.max(1, height - viewportH);

    return {
      percent: clampMetricNumber(((scrollTop + viewportH) / Math.max(height, 1)) * 100, 0, 100),
      depth: clampMetricNumber((scrollTop / scrollable) * 100, 0, 100),
      height: height
    };
  }

  function initSiteSectionMetrics() {
    var sections = collectMetricSections();
    var startedAt = Date.now();
    var sent = false;
    var maxScroll = maxScrollPercent();

    if (!sections.length) {
      return;
    }

    function refreshVisible() {
      var now = Date.now();

      maxScroll = (function (previous, next) {
        return {
          percent: Math.max(previous.percent, next.percent),
          depth: Math.max(previous.depth, next.depth),
          height: Math.max(previous.height, next.height)
        };
      })(maxScroll, maxScrollPercent());

      sections.forEach(function (item) {
        var percent = sectionVisiblePercent(item.node);

        if (percent > item.maxVisiblePercent) {
          item.maxVisiblePercent = percent;
        }
        if (percent >= 8) {
          if (!item.activeSince) {
            item.activeSince = now;
          }
        } else if (item.activeSince) {
          item.visibleMs += now - item.activeSince;
          item.activeSince = 0;
        }
      });
    }

    function flushSectionMetrics() {
      var now = Date.now();
      var payload;

      if (sent || now - startedAt < 1200) {
        return;
      }
      sent = true;
      refreshVisible();
      sections.forEach(function (item) {
        if (item.activeSince) {
          item.visibleMs += now - item.activeSince;
          item.activeSince = 0;
        }
      });
      payload = buildSiteMetricsPayload();
      payload.type = "section_view";
      payload.max_scroll_percent = Math.round(maxScroll.percent * 10) / 10;
      payload.max_scroll_depth = Math.round(maxScroll.depth * 10) / 10;
      payload.document_h = maxScroll.height;
      payload.duration_ms = now - startedAt;
      payload.sections = sections.map(function (item, index) {
        return {
          id: item.id,
          label: item.label,
          index: index,
          visible_ms: Math.max(0, Math.round(item.visibleMs)),
          max_visible_percent: Math.round(item.maxVisiblePercent * 10) / 10
        };
      });
      sendSiteMetrics(payload);
    }

    refreshVisible();
    window.addEventListener("scroll", refreshVisible, { passive: true });
    window.addEventListener("resize", refreshVisible);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        flushSectionMetrics();
      }
    });
    window.addEventListener("pagehide", flushSectionMetrics);
  }

  function sendSiteMetrics(payload) {
    var endpoint = rootAsset("metrics/collect.php");
    var body = JSON.stringify(payload);
    var blob;

    if (!body) {
      return;
    }

    if (navigator.sendBeacon) {
      try {
        blob = new Blob([body], { type: "application/json" });

        if (navigator.sendBeacon(endpoint, blob)) {
          return;
        }
      } catch (error) {
        // Fallback to fetch below.
      }
    }

    if (window.fetch) {
      fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: {
          "Content-Type": "application/json"
        },
        body: body
      }).catch(function () {
        // Silent failure keeps public pages unaffected.
      });
    }
  }

  function initSiteMetrics() {
    if (!shouldTrackSiteMetrics()) {
      return;
    }

    sendSiteMetrics(buildSiteMetricsPayload());
    initSiteSectionMetrics();
  }

  function initTranslateMenu() {
    var body = getBody();
    var translateButton = document.getElementById("translateBtn");
    var googleElement = document.getElementById("google_translate_element");

    if (!body || !body.hasAttribute("data-site-translate") || !translateButton || !googleElement) {
      return;
    }

    var menu = document.createElement("div");
    var languages = [
      ["en", "&#x1F1EC;&#x1F1E7;"],
      ["uk", "&#x1F1FA;&#x1F1E6;"],
      ["tr", "&#x1F1F9;&#x1F1F7;"],
      ["pl", "&#x1F1F5;&#x1F1F1;"],
      ["de", "&#x1F1E9;&#x1F1EA;"],
      ["fr", "&#x1F1EB;&#x1F1F7;"],
      ["es", "&#x1F1EA;&#x1F1F8;"],
      ["zh-CN", "&#x1F1E8;&#x1F1F3;"],
      ["ar", "&#x1F1F8;&#x1F1E6;"],
      ["ru", "&#x1F1F7;&#x1F1FA;"]
    ];

    translateButton.innerHTML = "&#x1F310;";
    menu.className = "site-lang-menu";
    menu.innerHTML = languages.map(function (language) {
      var extraClass = language[0] === "ru" ? " site-lang-menu__item--reset" : "";
      return '<button class="site-lang-menu__item' + extraClass + '" type="button" data-lang="' + language[0] + '">' + language[1] + "</button>";
    }).join("");

    document.body.appendChild(menu);

    menu.querySelectorAll("[data-lang]").forEach(function (item) {
      item.addEventListener("click", function () {
        var lang = item.getAttribute("data-lang");

        if (lang === "ru") {
          window.resetTranslation();
        } else {
          window.changeLanguage(lang);
        }

        closeLangMenu(menu);
      });
    });

    translateButton.addEventListener("click", function (event) {
      event.stopPropagation();

      if (showLangMenu) {
        closeLangMenu(menu);
      } else {
        openLangMenu(menu);
      }
    });

    document.addEventListener("click", function (event) {
      if (!menu.contains(event.target) && event.target !== translateButton) {
        closeLangMenu(menu);
      }
    });

    applyRequestedLanguage();
  }

  function initWarningModal() {
    var modal = document.getElementById("warningModal");
    var confirmButton = document.getElementById("confirmBtn");

    if (!modal || !confirmButton) {
      return;
    }

    var currentPage = window.location.pathname.split("/").filter(Boolean).pop() || "";
    var confirmationKey = "warningConfirmed:" + window.location.pathname;

    if (safeSessionGet(confirmationKey) === "true") {
      modal.style.display = "none";
      return;
    }

    modal.style.display = "flex";
    document.body.style.overflow = "hidden";

    confirmButton.addEventListener("click", function () {
      safeSessionSet(confirmationKey, "true");
      safeSessionSet("lastWarningPage", currentPage);
      modal.style.opacity = "0";
      document.body.style.overflow = "";

      setTimeout(function () {
        modal.style.display = "none";
        modal.style.opacity = "";
      }, 250);
    });
  }

  ready(function () {
    initLocalFolderLinks();
    initTheme();
    initLoader();
    initToTop();
    initSotAutoSets();
    initZoom();
    initAutoSectionCounts();
    initSaydisTitleCount();
    initManualTotalCount();
    initNoSelect();
    initHomePage();
    initUnifiedInstructions();
    initSiteLanguageFooters();
    initSotSort();
    initSotDemo();
    initSiteMetrics();
    initTranslateMenu();
    initWarningModal();
  });
}());
