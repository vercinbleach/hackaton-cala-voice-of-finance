export const FINANCE_REEL_CSS = String.raw`
:root {
  color-scheme: dark;
  font-family: "Trebuchet MS", sans-serif;
  background: #090c0a;
  --ink: #090c0a;
  --panel: #111814;
  --panel-2: #1b2620;
  --paper: #f2f4ef;
  --muted: #98a59e;
  --line: #314038;
  --up: #00a878;
  --down: #f04464;
  --signal: #dff247;
  --info: #54bdd1;
}

* {
  box-sizing: border-box;
}

html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: var(--ink);
}

body {
  position: relative;
}

#root {
  position: relative;
  width: 1080px;
  height: 1920px;
  overflow: hidden;
  isolation: isolate;
  color: var(--paper);
  background-color: var(--ink);
  background-image:
    linear-gradient(rgba(223, 242, 71, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(84, 189, 209, 0.035) 1px, transparent 1px);
  background-size: 72px 72px;
}

.frame-rail {
  position: absolute;
  inset: 0 auto 0 0;
  width: 18px;
  background: var(--signal);
  z-index: 60;
}

.masthead {
  position: absolute;
  z-index: 55;
  top: 54px;
  left: 72px;
  right: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 2px solid var(--line);
}

.brand {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0;
}

.live-mark {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--down);
  box-shadow: 0 0 0 7px rgba(240, 68, 100, 0.14);
}

.edition {
  color: var(--muted);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0;
}

.scene {
  position: absolute;
  inset: 0;
  padding: 172px 72px 290px 82px;
  overflow: hidden;
  opacity: 1;
}

.scene::after {
  content: "";
  position: absolute;
  z-index: -1;
  right: -110px;
  top: 188px;
  width: 360px;
  height: 360px;
  border: 2px solid rgba(84, 189, 209, 0.16);
  transform: rotate(14deg);
}

.scene-kicker {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--signal);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.scene-kicker::before {
  content: "";
  width: 42px;
  height: 4px;
  background: currentColor;
}

.hook-title,
.closing-title {
  max-width: 900px;
  margin: 38px 0 0;
  font-family: Georgia, serif;
  font-size: 112px;
  line-height: 1.01;
  font-weight: 700;
  letter-spacing: 0;
}

.hook-rule {
  width: 250px;
  height: 12px;
  margin-top: 46px;
  background: var(--info);
}

.hook-board {
  margin-top: 82px;
  border-top: 2px solid var(--line);
}

.hook-mover,
.closing-mover {
  min-height: 118px;
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 210px;
  align-items: center;
  gap: 24px;
  border-bottom: 2px solid var(--line);
}

.hook-ticker,
.closing-ticker {
  font-family: Georgia, serif;
  font-size: 44px;
  font-weight: 700;
  letter-spacing: 0;
}

.hook-company,
.closing-company {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 25px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0;
}

.hook-change,
.closing-change {
  justify-self: end;
  font-family: Georgia, serif;
  font-size: 46px;
  font-weight: 700;
  letter-spacing: 0;
}

.is-up {
  color: var(--up);
}

.is-down {
  color: var(--down);
}

.mover-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 28px;
  align-items: end;
  margin-top: 28px;
}

.mover-ticker {
  margin: 0;
  font-family: Georgia, serif;
  font-size: 106px;
  line-height: 0.95;
  font-weight: 700;
  letter-spacing: 0;
}

.mover-company {
  max-width: 650px;
  margin: 22px 0 0;
  color: var(--muted);
  font-size: 28px;
  line-height: 1.2;
  letter-spacing: 0;
}

.mover-change {
  padding-bottom: 5px;
  font-family: Georgia, serif;
  font-size: 74px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0;
}

.asset-card {
  position: absolute;
  top: 448px;
  left: 132px;
  width: 716px;
  height: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 24px 28px 0 rgba(223, 242, 71, 0.08);
}

.asset-chart {
  position: absolute;
  top: 1170px;
  left: 104px;
  width: 860px;
  height: auto;
  border-radius: 8px;
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.26);
}

.closing-copy {
  max-width: 900px;
  margin: 42px 0 0;
  color: var(--paper);
  font-size: 40px;
  line-height: 1.28;
  letter-spacing: 0;
}

.closing-board {
  margin-top: 78px;
  border-top: 2px solid var(--line);
}

.caption-layer {
  position: absolute;
  z-index: 70;
  left: 72px;
  right: 72px;
  bottom: 232px;
  min-height: 168px;
  display: flex;
  align-items: center;
  padding: 30px 38px 32px;
  border: 2px solid #3b4a42;
  border-top: 10px solid var(--signal);
  border-radius: 8px;
  background: rgba(9, 12, 10, 0.94);
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.35);
  font-size: 37px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: 0;
  opacity: 0;
}

.ticker-shell {
  position: absolute;
  z-index: 80;
  left: 18px;
  right: 0;
  bottom: 52px;
  height: 112px;
  overflow: hidden;
  border-top: 3px solid var(--signal);
  border-bottom: 3px solid var(--signal);
  background: var(--paper);
  color: var(--ink);
}

.ticker-label {
  position: absolute;
  z-index: 2;
  left: 0;
  top: 0;
  bottom: 0;
  width: 178px;
  display: grid;
  place-items: center;
  background: var(--signal);
  border-right: 3px solid var(--ink);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0;
}

.ticker-window {
  position: absolute;
  left: 178px;
  right: 0;
  top: 0;
  bottom: 0;
  overflow: hidden;
}

.ticker-track {
  height: 100%;
  display: flex;
  width: max-content;
  will-change: transform;
}

.ticker-group {
  width: 1080px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-around;
  flex: 0 0 1080px;
}

.ticker-item {
  display: inline-flex;
  align-items: baseline;
  gap: 13px;
  padding: 0 20px;
  white-space: nowrap;
  font-family: Georgia, serif;
  font-size: 31px;
  font-weight: 700;
  letter-spacing: 0;
}

.ticker-item strong {
  font-family: "Trebuchet MS", sans-serif;
  font-size: 26px;
  letter-spacing: 0;
}

.frame-count {
  position: absolute;
  z-index: 61;
  right: 72px;
  bottom: 10px;
  color: #68756e;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
}
`;
