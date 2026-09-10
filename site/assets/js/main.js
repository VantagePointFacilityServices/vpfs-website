// Vantage Point Facility Services — shared site behaviour

document.addEventListener('DOMContentLoaded', function () {

  // Mobile nav toggle
  var navToggle = document.querySelector('.nav-toggle');
  var mainNav = document.querySelector('.main-nav');
  if (navToggle && mainNav) {
    navToggle.addEventListener('click', function () {
      mainNav.classList.toggle('open');
    });
  }

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(function (item) {
    var q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', function () {
      var isOpen = item.classList.contains('open');
      item.closest('.faq-list').querySelectorAll('.faq-item').forEach(function (i) {
        i.classList.remove('open');
      });
      if (!isOpen) item.classList.add('open');
    });
  });

  // Tabs (Services scope detail)
  document.querySelectorAll('.tabs-nav').forEach(function (nav) {
    var target = nav.getAttribute('data-tabs-target');
    var panelGroup = document.querySelector('[data-tab-panels="' + target + '"]');
    if (!panelGroup) return;

    function selectTab(name, btn) {
      nav.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      panelGroup.querySelectorAll('.tab-panel').forEach(function (panel) {
        panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === name);
      });
    }

    nav.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectTab(btn.getAttribute('data-tab'), btn);
      });
    });

    // Deep-link support: services.html#offices selects that tab and brings the
    // whole section into view, so the tab bar's active state is visible too.
    // Also runs on hashchange, so a submenu link clicked while already on this
    // page (same-document navigation — no reload, so DOMContentLoaded won't
    // fire again) still switches tabs.
    function applyHash() {
      var hash = window.location.hash.replace('#', '');
      if (!hash) return;
      var matchBtn = nav.querySelector('[data-tab="' + hash + '"]');
      if (matchBtn) {
        selectTab(hash, matchBtn);
        var scopeSection = nav.closest('section') || nav;
        scopeSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    applyHash();
    window.addEventListener('hashchange', applyHash);
  });

  // Nav dropdown — "Services" is a real link to services.html; on desktop the
  // submenu also opens on hover (CSS). The chevron button is a separate
  // disclosure toggle so touch devices (no hover) can still reach it.
  document.querySelectorAll('.nav-dropdown-chevron').forEach(function (btn) {
    var item = btn.closest('.has-dropdown');
    if (!item) return;

    function setOpen(isOpen) {
      item.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      setOpen(!item.classList.contains('open'));
    });

    item.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && item.classList.contains('open')) {
        setOpen(false);
        btn.focus();
      }
    });

    document.addEventListener('click', function (e) {
      if (!item.contains(e.target)) setOpen(false);
    });
    item.addEventListener('focusout', function (e) {
      if (!item.contains(e.relatedTarget)) setOpen(false);
    });
  });
  // Services hero carousel — auto-advance every 5s, opacity crossfade, dot nav
  var carousel = document.querySelector('.carousel');
  if (carousel) {
    var slides = Array.prototype.slice.call(carousel.querySelectorAll('.carousel-slide'));
    var dots = Array.prototype.slice.call(carousel.querySelectorAll('.carousel-dots button'));
    var captionHeading = carousel.querySelector('.carousel-caption h2');
    var captionText = carousel.querySelector('.carousel-caption p');
    var current = 0;
    var timer = null;

    function show(index) {
      slides.forEach(function (s, i) { s.classList.toggle('active', i === index); });
      dots.forEach(function (d, i) { d.classList.toggle('active', i === index); });
      var active = slides[index];
      if (captionHeading) captionHeading.textContent = active.dataset.captionHeading || '';
      if (captionText) captionText.textContent = active.dataset.captionText || '';
      current = index;
    }

    function next() {
      show((current + 1) % slides.length);
    }

    function restart() {
      if (timer) clearInterval(timer);
      timer = setInterval(next, 5000);
    }

    dots.forEach(function (dot, i) {
      dot.addEventListener('click', function () {
        show(i);
        restart();
      });
    });

    show(0);
    restart();
  }

  // Contact form — client-side success state (no backend wired up yet)
  var form = document.querySelector('.assessment-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fields = form.querySelector('.form-fields');
      var success = form.querySelector('.form-success');
      if (fields) fields.style.display = 'none';
      if (success) success.classList.add('show');
    });
  }
});
