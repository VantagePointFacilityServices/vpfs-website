// One expected short notice per form type (PRD D4, layered notice). The full notice lives at privacy.html#collection-notice.
const LINKS = 'How we handle them: <a href="/privacy.html#collection-notice">collection notice</a> · <a href="/privacy.html">Privacy Policy</a>.';

export const NOTICES = {
  careers: `We collect these details to assess your application, including any screening checks a client site requires (we'll ask first). ${LINKS}`,
  area: `We collect these details to tell you when we cover your area. ${LINKS}`,
};

export function noticeTypeFor(form) {
  if (form.id === "apply") return "careers";
  return form.hasAttribute("data-conversion-page") ? "lead" : "area";
}
