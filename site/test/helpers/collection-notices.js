// One expected short notice per form type (PRD D4, layered notice). The full notice lives at privacy.html#collection-notice.
const LINKS = 'How we handle them: <a href="/privacy.html#collection-notice">collection notice</a> · <a href="/privacy.html">Privacy Policy</a>.';

export const NOTICES = {
};

export function noticeTypeFor(form) {
  return form.hasAttribute("data-conversion-page") ? "lead" : "area";
}
