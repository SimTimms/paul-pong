import { useCallback, useEffect, useRef, useState } from "react";
import { PongEngine, type GameSnapshot } from "./game/pongEngine";
import "./App.css";

// Served from the public/ folder at the site root.
const headUrl = "/head.png";

const INITIAL: GameSnapshot = {
  status: "ready",
  scoreLeft: 0,
  scoreRight: 0,
  winner: null,
  announcement: "",
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PongEngine | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot>(INITIAL);

  // Boot the engine once the head image has loaded.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const head = new Image();
    head.src = headUrl;

    let engine: PongEngine | null = null;
    const boot = () => {
      engine = new PongEngine(canvas, head, {
        maxScore: 7,
        onChange: setSnapshot,
      });
      engineRef.current = engine;
    };

    if (head.complete) boot();
    else {
      head.onload = boot;
      head.onerror = boot; // fall back to a drawn disc if the asset is missing
    }

    return () => {
      engine?.destroy();
      engineRef.current = null;
    };
  }, []);

  // Keyboard controls: paddle movement + start/pause.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          engine.setKey("up", true);
          e.preventDefault();
          break;
        case "ArrowDown":
        case "s":
        case "S":
          engine.setKey("down", true);
          e.preventDefault();
          break;
        case " ":
        case "Enter":
          if (snapshot.status === "playing") engine.togglePause();
          else engine.start();
          e.preventDefault();
          break;
        default:
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") engine.setKey("up", false);
      if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") engine.setKey("down", false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [snapshot.status]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = ((e.clientY - rect.top) / rect.height) * engine.height;
    engine.setPlayerTarget(y);
  }, []);

  const handlePointerLeave = useCallback(() => {
    engineRef.current?.setPlayerTarget(null);
  }, []);

  const primaryLabel =
    snapshot.status === "playing"
      ? "Pause"
      : snapshot.status === "paused"
        ? "Resume"
        : snapshot.status === "over"
          ? "Play again"
          : "Start";

  const onPrimary = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (snapshot.status === "playing") engine.togglePause();
    else engine.start();
  };

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Paul Pong</h1>
 
      </header>

      <main className="game">
        <div className="game__scoreboard" aria-hidden="true">
          <span className="game__score game__score--player">{snapshot.scoreLeft}</span>
          <span className="game__score-divider">vs</span>
          <span className="game__score game__score--cpu">{snapshot.scoreRight}</span>
        </div>

        <div className="game__stage">
          <canvas
            ref={canvasRef}
            className="game__canvas"
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            role="img"
            aria-label={`Pong court. You ${snapshot.scoreLeft}, computer ${snapshot.scoreRight}. Status: ${snapshot.status}.`}
          />
        </div>

        <div className="game__controls">
          <button type="button" className="btn btn--primary" onClick={onPrimary}>
            {primaryLabel}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => engineRef.current?.resetMatch()}
          >
            Reset match
          </button>
        </div>

        <section className="instructions" aria-label="How to play">
          <h2 className="instructions__heading">How to play</h2>
          <ul className="instructions__list">
            <li>Move your paddle with the mouse, or the Up / Down arrows (or W / S).</li>
            <li>Press Space or Enter to start, pause, and resume.</li>
            <li>First to 7 points wins the match.</li>
          </ul>
        </section>

        {/* Screen-reader live region mirroring the game state. */}
        <p className="sr-only" aria-live="polite" role="status">
          {snapshot.announcement}
        </p>
      </main>
    </div>
  );
}

export default App;
