document.addEventListener('DOMContentLoaded', function () {
  // Mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      nav.classList.toggle('open');
    });
  }

  // Nav dropdown — disclosure pattern. Desktop hover/focus opening is handled
  // in CSS; this covers click, Escape and dismissal.
  document.querySelectorAll('.has-dropdown').forEach(function (item) {
    var btn = item.querySelector('.nav-dropdown-toggle');
    if (!btn) return;

    function setOpen(isOpen) {
      item.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    btn.addEventListener('click', function () {
      setOpen(!item.classList.contains('open'));
    });

    item.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && item.classList.contains('open')) {
        setOpen(false);
        btn.focus();
      }
    });

    // Click outside, and tabbing out of the group, both close it.
    document.addEventListener('click', function (e) {
      if (!item.contains(e.target)) setOpen(false);
    });
    item.addEventListener('focusout', function (e) {
      if (!item.contains(e.relatedTarget)) setOpen(false);
    });
  });

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(function (item) {
    var q = item.querySelector('.faq-q');
    q.addEventListener('click', function () {
      var wasOpen = item.classList.contains('open');
      item.parentElement.querySelectorAll('.faq-item').forEach(function (i) {
        i.classList.remove('open');
      });
      if (!wasOpen) item.classList.add('open');
    });
  });

  // Assessment request form(s) — placeholder submit handler until CRM is wired up
  document.querySelectorAll('.assessment-form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // Honeypot: a real user never sees these, so anything in them is a bot.
      // Show the normal success state so the bot has no signal it was caught.
      var trap = form.querySelector('.hp-field input[name="website_url"]');
      var trap2 = form.querySelector('.hp-field input[name="company"]');
      var caught = (trap && trap.value) || (trap2 && trap2.value);

      var body = form.querySelector('.form-fields');
      var success = form.querySelector('.form-success');

      // TODO: POST to the CRM here — send only when `caught` is false.
      form.setAttribute('data-lead-ready', caught ? 'false' : 'true');

      // The success state shows either way, so a bot gets no signal.
      if (body) body.style.display = 'none';
      if (success) success.classList.add('show');
    });
  });
});
