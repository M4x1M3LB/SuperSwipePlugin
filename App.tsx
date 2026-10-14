/**
 * SuperSwipe settings view. Black and white, no animation: e-ink friendly.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {ensureFileAccess} from './src/host';
import {restoreLastErase} from './src/plugin';
import type {Gestures} from './src/selector';
import {describeOutcome, status} from './src/status';

function useStatus() {
  const [, setTick] = useState(0);
  useEffect(() => status.subscribe(() => setTick(t => t + 1)), []);
  return status;
}

function Toggle(props: {label: string; name: keyof Gestures}) {
  const on = status.gestures()[props.name];
  return (
    <Pressable
      style={[styles.button, on && styles.buttonOn]}
      onPress={() => status.setGesture(props.name, !on)}>
      <Text style={[styles.buttonText, on && styles.buttonTextOn]}>
        {props.label}: {on ? 'ON' : 'OFF'}
      </Text>
    </Pressable>
  );
}

function App(): React.JSX.Element {
  const s = useStatus();
  const [message, setMessage] = useState<string | null>(null);

  const requestAccess = async () => {
    const granted = await ensureFileAccess();
    setMessage(
      granted ? 'File access granted.' : 'File access was not granted.',
    );
  };

  const restore = async () => {
    setMessage(await restoreLastErase());
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
        With a pen (not the marker): draw a closed loop around strokes to
        lasso-select them, or a small ✕ in the left margin, level with a line of
        writing, to erase that line.
      </Text>

      <Toggle label="Loop to select" name="loopSelect" />
      <Toggle label="Margin ✕ to erase" name="marginErase" />

      <View style={styles.row}>
        <Pressable style={styles.button} onPress={restore}>
          <Text style={styles.buttonText}>Restore last erase</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={requestAccess}>
          <Text style={styles.buttonText}>Grant file access</Text>
        </Pressable>
      </View>
      {message && <Text style={styles.body}>{message}</Text>}

      <Text style={styles.status}>{describeOutcome(s.lastOutcome())}</Text>
      <Text style={styles.traceLine}>Strokes received: {s.penUpCount()}</Text>
      {s.lastTrace().length > 0 && (
        <View style={styles.trace}>
          {s.lastTrace().map((line, i) => (
            <Text key={i} style={styles.traceLine}>
              {line}
            </Text>
          ))}
        </View>
      )}
      <Text style={styles.note}>
        Note: gestures clear the page's undo history (Supernote limitation). Use
        Restore last erase to undo an erase.
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
  row: {
    flexDirection: 'row',
    gap: 16,
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
  trace: {
    marginTop: 12,
    borderLeftWidth: 2,
    borderLeftColor: '#000000',
    paddingLeft: 12,
  },
  traceLine: {
    fontSize: 16,
    color: '#000000',
    fontFamily: 'monospace',
  },
  note: {
    fontSize: 18,
    color: '#000000',
    marginTop: 24,
  },
});

export default App;
