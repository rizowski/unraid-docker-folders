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
 * `backend` works the same way, from window.dockerFoldersBackendMode. The
 * frame cannot read a global set out here, so which backend the app talks to
 * has to travel in the URL like csrf_token and theme do. Omitted when the
 * page did not set it, and the app then defaults to PHP.
 */
window.dockerFoldersFrameSrc = function(page) {
  var token = (typeof csrf_token === 'string') ? csrf_token : '';
  var vars = [
    '--text-color', '--background-color', '--border-color',
    '--header-background', '--header-text-color',
    '--button-background', '--button-hover', '--button-text-color',
    '--input-background', '--input-border'
  ];
  var cs = getComputedStyle(document.documentElement);
  var theme = {};
  vars.forEach(function(v) {
    var val = cs.getPropertyValue(v).trim();
    if (val) theme[v] = val;
  });
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
