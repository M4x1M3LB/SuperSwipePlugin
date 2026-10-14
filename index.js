/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {startLoopSelect} from './src/plugin';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Settings view: from Settings -> Apps -> Plugins, and from the NOTE toolbar.
PluginManager.registerConfigButton();
PluginManager.registerConfigButtonListener({
  onClick() {
    PluginManager.showPluginView();
  },
});

const SETTINGS_BUTTON_ID = 100;
PluginManager.registerButton(1, ['NOTE'], {
  id: SETTINGS_BUTTON_ID,
  name: 'SuperSwipe',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

startLoopSelect();
