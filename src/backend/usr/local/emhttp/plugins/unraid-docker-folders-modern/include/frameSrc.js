/*
 * Builds the URL for a plugin iframe page: the CSRF token plus the parent's Unraid
 * theme variables, which the iframe cannot read on its own. Loaded by Folders.page
 * and DockerFoldersDashboard.page, so both frames get the same theme list.
 *
 * The `v` param is the iframe document's mtime, which is what makes a plugin
 * update reach the browser. index.html and widget.html carry no content hash
 * and csrf_token/theme do not change between builds, so without it the URL is
 * a stable cache key and the browser keeps serving the previous build. This
 * file cannot call filemtime(), so each page file sets the value on
 * window.dockerFoldersAssetVersion before calling this. Read it inside the
 * function, not at file scope: the two pages set it at different points
 * relative to this script tag.
 *
 * The URL theme is only the first paint. dockerFoldersWatchTheme (below) keeps the
 * frame current afterwards, and the frame applies both through one code path.
 *
 * `backend` works the same way, from window.dockerFoldersBackendMode. The
 * frame cannot read a global set out here, so which backend the app talks to
 * has to travel in the URL like csrf_token and theme do. Omitted when the
 * page did not set it, and the app then defaults to PHP.
 */
var DFM_THEME_VARS = [
  '--text-color', '--background-color', '--border-color',
  '--header-background', '--header-text-color',
  '--button-background', '--button-hover', '--button-text-color',
  '--input-background', '--input-border'
];

/*
 * The parent's current theme as {variable: value}, read from <html>.
 * getComputedStyle resolves var() chains, so a theme that defines
 * `--background-color: var(--nr-bg)` still yields a plain colour. A variable the
 * theme does not define is left out, and the frame then keeps its own fallback.
 */
window.dockerFoldersReadTheme = function() {
  var cs = getComputedStyle(document.documentElement);
  var theme = {};
  DFM_THEME_VARS.forEach(function(v) {
    var val = cs.getPropertyValue(v).trim();
    if (val) theme[v] = val;
  });
  return theme;
};

/*
 * Follow the parent's theme while the page stays open. A theme that switches in
 * place (a day/night toggle that flips a class on <html>) never reloads the
 * frame, so the URL snapshot goes stale. Watches <html> and <body> for class,
 * style and data-* changes, plus the OS colour-scheme preference, and posts
 * {type: 'docker-folders-theme', theme} to the frame when the values changed.
 *
 * getFrame returns the iframe element. Call the returned function with `true`
 * to send regardless of change, which is how a frame that has just loaded
 * (and may have missed an update) catches up. Call this right after the frame
 * src is built: the theme at that moment is the one the URL carries.
 */
window.dockerFoldersWatchTheme = function(getFrame) {
  var last = JSON.stringify(window.dockerFoldersReadTheme());
  var timer = null;

  function send(force) {
    var frame = getFrame();
    var theme = window.dockerFoldersReadTheme();
    var json = JSON.stringify(theme);
    if (!force && json === last) return;
    last = json;
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'docker-folders-theme', theme: theme }, window.location.origin);
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function() { send(false); }, 50);
  }

  var observer = new MutationObserver(schedule);
  var options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme', 'data-color-scheme'] };
  observer.observe(document.documentElement, options);
  if (document.body) observer.observe(document.body, options);

  if (window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    if (media.addEventListener) media.addEventListener('change', schedule);
    else if (media.addListener) media.addListener(schedule);
  }
  return send;
};

window.dockerFoldersFrameSrc = function(page) {
  var token = (typeof csrf_token === 'string') ? csrf_token : '';
  var theme = window.dockerFoldersReadTheme();
  var themeParam = Object.keys(theme).length > 0
    ? '&theme=' + encodeURIComponent(JSON.stringify(theme))
    : '';
  var backend = window.dockerFoldersBackendMode;
  var backendParam = (backend === 'graphql' || backend === 'php')
    ? '&backend=' + encodeURIComponent(backend)
    : '';
  var version = window.dockerFoldersAssetVersion;
  var versionParam = (version !== undefined && version !== null && version !== '')
    ? '&v=' + encodeURIComponent(String(version))
    : '';
  return '/plugins/unraid-docker-folders-modern/assets/' + page + '?csrf_token=' + encodeURIComponent(token) + themeParam + backendParam + versionParam;
};
