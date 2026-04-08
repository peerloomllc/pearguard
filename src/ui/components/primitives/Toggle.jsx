import { useTheme } from '../../theme.js';

export default function Toggle({ checked, onChange, style }) {
  const { colors } = useTheme();

  const trackW = 44;
  const trackH = 24;
  const thumbSize = 20;
  const offset = checked ? trackW - thumbSize - 2 : 2;

  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => { window.callBare('haptic:tap'); onChange(!checked); }}
      style={{
        position: 'relative',
        width: `${trackW}px`,
        height: `${trackH}px`,
        borderRadius: `${trackH / 2}px`,
        border: 'none',
        cursor: 'pointer',
        backgroundColor: checked ? colors.primary : colors.border,
        transition: 'background-color 0.2s, border-color 0.2s',
        padding: 0,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '2px',
          left: `${offset}px`,
          width: `${thumbSize}px`,
          height: `${thumbSize}px`,
          borderRadius: '50%',
          backgroundColor: '#FFFFFF',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s',
        }}
      />
    </button>
  );
}
