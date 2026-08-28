// jsdom implements no layout, so it has no `scrollIntoView` — the list
// components call it whenever the selection moves.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
