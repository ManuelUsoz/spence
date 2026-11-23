const version = require('./package.json').version;
const squirrelVersion = version.replace(
  /-rc\.(\d+)$/,
  (_, number) => `-rc${number.padStart(8, '0')}`,
);

const config = {
  packagerConfig: {
    name: 'Spence',
    executableName: 'spence',
    icon: './build/icon',
    asar: true,
    ignore: (file) =>
      file !== '' &&
      !/^\/(dist\/renderer|dist-electron|build\/icon|package\.json)(\/|\.|$)/.test(file) &&
      file !== '/dist' &&
      file !== '/build',
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'spence',
        authors: 'Spence',
        setupIcon: './build/icon.ico',
        version: squirrelVersion,
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          version: version.replace(/-rc\.(\d+)$/, '~rc$1'),
          depends: ['pkexec'],
          maintainer: 'Spence <ManuelUsoz@users.noreply.github.com>',
          homepage: 'https://github.com/ManuelUsoz/spence',
          icon: './build/icon.png',
        },
      },
    },
    { name: '@electron-forge/maker-rpm', config: {} },
  ],
};
module.exports = config;
