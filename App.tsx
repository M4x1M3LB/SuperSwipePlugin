/**
 * SuperSwipe settings view. Black and white, no animation: e-ink friendly.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {ensureFileAccess} from './src/host';
import {describeOutcome, status} from './src/status';

function useStatus() {
  const [, setTick] = useState(0);
  useEffect(() => status.subscribe(() => setTick(t => t + 1)), []);
  return status;
}

function App(): React.JSX.Element {
  const s = useStatus();
  const [access, setAccess] = useState<string | null>(null);

  const requestAccess = async () => {
    const granted = await ensureFileAccess();
    setAccess(
      granted ? 'File access granted.' : 'File access was not granted.',
    );
  };

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.close}
        onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      <Text style={styles.title}>SuperSwipe</Text>
      <Text style={styles.body}>
        Draw a closed loop around strokes with a pen (not the marker). The loop
        disappears and what it enclosed is lasso-selected.
      </Text>

      <Pressable
        style={[styles.button, s.isEnabled() && styles.buttonOn]}
        onPress={() => s.setEnabled(!s.isEnabled())}>
        <Text style={[styles.buttonText, s.isEnabled() && styles.buttonTextOn]}>
          Loop to select: {s.isEnabled() ? 'ON' : 'OFF'}
        </Text>
      </Pressable>

      <Pressable style={styles.button} onPress={requestAccess}>
        <Text style={styles.buttonText}>Grant file access</Text>
      </Pressable>
      {access && <Text style={styles.body}>{access}</Text>}

      <Text style={styles.status}>{describeOutcome(s.lastOutcome())}</Text>
      <Text style={styles.note}>
        Note: removing the loop clears the page's undo history (Supernote
        limitation).
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 48,
    backgroundColor: '#ffffff',
  },
  close: {
    position: 'absolute',
    top: 16,
    right: 16,
    padding: 12,
  },
  closeText: {
    fontSize: 28,
    color: '#000000',
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 16,
  },
  body: {
    fontSize: 22,
    color: '#000000',
    marginBottom: 24,
  },
  button: {
    borderWidth: 2,
    borderColor: '#000000',
    paddingVertical: 16,
    paddingHorizontal: 24,
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  buttonOn: {
    backgroundColor: '#000000',
  },
  buttonText: {
    fontSize: 22,
    color: '#000000',
  },
  buttonTextOn: {
    color: '#ffffff',
  },
  status: {
    fontSize: 22,
    color: '#000000',
    marginTop: 24,
  },
  note: {
    fontSize: 18,
    color: '#000000',
    marginTop: 24,
  },
});

export default App;
