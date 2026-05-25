// Faux QR-looking pattern (deterministic, density configurable)
const QrPattern = ({ size = 200, seed = 7, fg = "#0c0a09", bg = "#ffffff", quiet = 12 }) => {
  const grid = 25;
  const cell = (size - quiet * 2) / grid;
  // pseudo-random based on seed
  const rand = (i) => {
    const x = Math.sin((i + 1) * seed * 9301 + 49297) * 233280;
    return x - Math.floor(x);
  };
  const cells = [];
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      // finder squares at corners
      const inFinder =
        (x < 7 && y < 7) ||
        (x >= grid - 7 && y < 7) ||
        (x < 7 && y >= grid - 7);
      if (inFinder) continue;
      if (rand(y * grid + x) > 0.52) {
        cells.push(<rect key={`${x}-${y}`} x={quiet + x * cell} y={quiet + y * cell} width={cell} height={cell} fill={fg} />);
      }
    }
  }
  // finder pattern helper
  const Finder = ({ ox, oy }) => (
    <g transform={`translate(${quiet + ox * cell}, ${quiet + oy * cell})`}>
      <rect x="0" y="0" width={cell * 7} height={cell * 7} fill={fg} />
      <rect x={cell} y={cell} width={cell * 5} height={cell * 5} fill={bg} />
      <rect x={cell * 2} y={cell * 2} width={cell * 3} height={cell * 3} fill={fg} />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <rect width={size} height={size} fill={bg} />
      {cells}
      <Finder ox={0} oy={0} />
      <Finder ox={grid - 7} oy={0} />
      <Finder ox={0} oy={grid - 7} />
    </svg>
  );
};

// Code39-style barcode placeholder
const BarcodePattern = ({ width = 220, height = 48, fg = "#0c0a09", seed = 3 }) => {
  const bars = [];
  let x = 4;
  let i = 0;
  while (x < width - 4) {
    const w = ((Math.sin(i * seed + 1) + 1) * 2.4) + 1;
    if (i % 2 === 0) bars.push(<rect key={i} x={x} y={4} width={w} height={height - 8} fill={fg} />);
    x += w + 1;
    i++;
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      {bars}
    </svg>
  );
};

Object.assign(window, { QrPattern, BarcodePattern });
