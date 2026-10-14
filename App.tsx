/**
 * SuperSwipe settings view. Black and white, no animation: e-ink friendly.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
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
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Pressable
        style={styles.close}
        onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      <Text style={styles.title}>SuperSwipe</Text>
      <Text style={styles.body}>
        With a pen (not the marker): draw a closed loop around strokes to
        lasso-select them. A straight horizontal line, a few words long or more
        and clear of the writing, selects what is above or below it (you are
        asked which when there is writing on both sides). A vertical bar in the
        margin beside some lines selects that block. To erase a line of writing,
        draw a sideways wave with three bounces or more (∿∿, a tilde with an
        extra bounce) in the margin next to it, left or right, leaving a small
        gap.
      </Text>

      <Toggle label="Loop to select" name="loopSelect" />
      <Toggle label="Line to select above/below" name="lineSelect" />
      <Toggle label="Margin bar to select a block" name="barSelect" />
      <Toggle label="Margin wave to erase" name="marginErase" />
      <Toggle label="Refresh screen after an erase" name="screenRefresh" />

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
      <Text style={styles.traceLine}>{s.pageReadSummary()}</Text>
      <Text style={styles.traceLine}>
        Screen listeners: {s.listenerCount()}. Pen events by action:{' '}
        {s.motionSummary()}
      </Text>
      {s.history().length > 1 && (
        <View style={styles.trace}>
          <Text style={styles.traceLine}>Recent strokes:</Text>
          {s.history().map((line, i) => (
            <Text key={i} style={styles.traceLine}>
              {line}
            </Text>
          ))}
        </View>
      )}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flexGrow: 1,
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
