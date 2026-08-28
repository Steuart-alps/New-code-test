const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Metro can discover the sibling web artifact through the workspace links. Vite
// creates and removes this temporary directory while optimizing dependencies;
// if Metro starts watching it, the disappearing directory crashes the bundler.
const complianceViteTemp = path.resolve(
  __dirname,
  '../compliance-tracker/node_modules/.vite',
);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [
  new RegExp(`${escapeRegExp(complianceViteTemp)}(?:[\\/].*)?$`),
];

module.exports = config;
