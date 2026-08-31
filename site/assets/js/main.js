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
    nav.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        nav.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var name = btn.getAttribute('data-tab');
        panelGroup.querySelectorAll('.tab-panel').forEach(function (panel) {
          panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === name);
        });
      });
    });
  });

  // Services hero carousel — auto-advance every 5s, opacity crossfade, dot nav
  var carousel = document.querySelector('.carousel');
  if (carousel) {
    var slides = Array.prototype.slice.call(carousel.querySelectorAll('.carousel-slide'));
    var dots = Array.prototype.slice.call(carousel.querySelectorAll('.carousel-dots button'));
    var current = 0;
    var timer = null;

    function show(index) {
      slides.forEach(function (s, i) { s.classList.toggle('active', i === index); });
      dots.forEach(function (d, i) { d.classList.toggle('active', i === index); });
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
