// Runs at document_start in MAIN world — before ESPN overrides window.fetch.
// Saves a reference to the native fetch for use by injected scripts later.
window.__nativeFetch = window.fetch.bind(window);
