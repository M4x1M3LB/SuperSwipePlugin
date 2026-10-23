/**
 * The plugin host on the device provides sn-plugin-lib's native side, so it
 * is not linked into LasEr's own native package (which only holds the
 * floating button). Its Android dependencies also come from jitpack.io.
 */
module.exports = {
  dependencies: {
    'sn-plugin-lib': {
      platforms: {android: null},
    },
  },
};
