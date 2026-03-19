import React from 'react';

export default function ChildDetail({ child, onBack }) {
  return (
    <div>
      Detail {child.displayName} <button onClick={onBack}>Back</button>
    </div>
  );
}
