import type { GameInput } from "../../shared/types";

interface DemoFrameState {
  x: number;
  y: number;
  lastInput: GameInput | null;
  revision: number;
}

export function renderDemoFrame(state: DemoFrameState): string {
  const playerX = 16 + Math.max(0, Math.min(15, state.x)) * 8;
  const playerY = 24 + Math.max(0, Math.min(12, state.y)) * 8;
  const trees = Array.from({ length: 10 }, (_, index) => {
    const x = 8 + ((index * 29) % 145);
    const y = index % 2 === 0 ? 8 : 128;
    return `<g transform="translate(${x} ${y})"><rect width="7" height="7" fill="#26351d"/><rect x="2" y="7" width="3" height="4" fill="#596b31"/></g>`;
  }).join("");
  const houses = [
    `<g transform="translate(16 36)"><rect width="38" height="28" fill="#758847"/><path d="M-3 6h44L34 0H4z" fill="#2d3d24"/><rect x="16" y="16" width="8" height="12" fill="#27351e"/></g>`,
    `<g transform="translate(105 30)"><rect width="38" height="28" fill="#758847"/><path d="M-3 6h44L34 0H4z" fill="#2d3d24"/><rect x="16" y="16" width="8" height="12" fill="#27351e"/></g>`
  ].join("");
  const action = state.lastInput ? state.lastInput.toUpperCase() : "WAIT";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="144" viewBox="0 0 160 144" shape-rendering="crispEdges">
  <rect width="160" height="144" fill="#afbd69"/>
  <path d="M72 0h18v144H72zM0 70h160v18H0z" fill="#c7cf82"/>
  <path d="M0 90h160v32H0z" fill="#8fa050"/>
  <path d="M0 94h160M0 102h160M0 110h160M0 118h160" stroke="#7b8e45" stroke-width="1" stroke-dasharray="2 3"/>
  ${trees}
  ${houses}
  <g transform="translate(${playerX} ${playerY})">
    <rect x="2" width="6" height="3" fill="#27351e"/>
    <rect x="1" y="3" width="8" height="6" fill="#51632e"/>
    <rect x="2" y="9" width="2" height="3" fill="#27351e"/>
    <rect x="6" y="9" width="2" height="3" fill="#27351e"/>
    <rect y="5" width="2" height="3" fill="#27351e"/>
    <rect x="8" y="5" width="2" height="3" fill="#27351e"/>
  </g>
  <rect x="2" y="2" width="50" height="11" fill="#d7dd95" stroke="#27351e"/>
  <text x="6" y="10" fill="#27351e" font-family="monospace" font-size="6">${action} · ${state.revision}</text>
</svg>`;
}
