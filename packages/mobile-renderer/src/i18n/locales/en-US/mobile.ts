export default {
  shell: {
    title: 'xyz-agent',
    tabSessions: 'Sessions',
    tabFiles: 'Files',
    tabSettings: 'Settings',
  },
  connect: {
    title: 'Connect to server',
    placeholder: 'Paste connection info (ws://, http://, deep-link or URL/Token lines)',
    connect: 'Connect',
    hintUnrecognized: 'Unrecognized connection info. Supports ws://, http://, deep-link, URL/Token lines',
  },
  session: {
    new: 'New',
    empty: 'No sessions yet. Tap + to create.',
  },
  files: {
    empty: 'File tree is empty or still loading.',
    selectSession: 'Select a session in the Sessions tab to view its files.',
  },
  chat: {
    back: 'Back',
    empty: 'Send a message to start',
    composerPlaceholder: 'Type a message…',
    roleUser: 'You',
    roleAssistant: 'Agent',
  },
  newSession: {
    title: 'New session',
    promptPlaceholder: 'Describe the task…',
    cwdLabel: 'Server path',
    cwdPlaceholder: 'Enter server path, e.g. ~/projects/xyz-agent',
    submit: 'Create and start',
    cancel: 'Cancel',
    errorCreate: 'Failed to create session: {msg}',
  },
  settings: {
    title: 'Settings',
    connectionInfo: 'Connection',
    host: 'Host',
    token: 'Token',
    disconnect: 'Disconnect',
    theme: 'Theme',
    deviceName: 'Device name',
  },
}
