/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { bootstrapApp } from './src/app/appEntry';

// Section 12.2: the catalog is activated before the first render, so no frame
// is ever drawn in the wrong language. Section 6.2: the engine event stream and
// the AppState bridge are live from the moment the bundle evaluates, whether or
// not React has mounted anything yet.
bootstrapApp();

AppRegistry.registerComponent(appName, () => App);
