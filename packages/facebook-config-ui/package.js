Package.describe({
  summary: "Blaze configuration templates for Facebook OAuth.",
  version: "1.0.0-beta.0"
});

Package.onUse(function(api) {
  api.use('templating@1.2.13', 'client');

  api.addFiles('facebook_login_button.css', 'client');
  api.addFiles(
    ['facebook_configure.html', 'facebook_configure.js'],
    'client');
});
