/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {deleteSelection, startGestures} from './src/plugin';

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
  name: 'LasEr',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

// In the lasso toolbar: delete the selection the way the margin wave
// erases (the device's own delete of a plugin-made selection does not
// stick).
const DELETE_BUTTON_ID = 200;
PluginManager.registerButton(2, ['NOTE'], {
  id: DELETE_BUTTON_ID,
  name: 'Delete',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  editDataTypes: [0, 1, 2, 3, 4, 5],
  showType: 0,
});
PluginManager.registerButtonListener({
  onButtonPress(event) {
    if (event.id === DELETE_BUTTON_ID) {
      deleteSelection();
    }
  },
});

startGestures();
