/*
 * Builds the URL for a plugin iframe page: the CSRF token plus the parent's Unraid
 * theme variables, which the iframe cannot read on its own. Loaded by Folders.page
 * and DockerFoldersDashboard.page, so both frames get the same theme list.
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
  return '/plugins/unraid-docker-folders-modern/assets/' + page + '?csrf_token=' + encodeURIComponent(token) + themeParam;
};
