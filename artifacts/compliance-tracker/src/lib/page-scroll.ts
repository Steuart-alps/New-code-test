/** The element that scrolls a signed-in page (AppLayout's content column). */
export const APP_SCROLL_ID = "app-page-scroll";

/**
 * Scroll the page back to the top. On desktop the page scrolls inside
 * AppLayout's content column, not the window; on phones the window scrolls.
 */
export function scrollPageToTop() {
  document.getElementById(APP_SCROLL_ID)?.scrollTo({ top: 0, behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
