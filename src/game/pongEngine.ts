export type GameStatus = "ready" | "playing" | "paused" | "over";

export interface GameSnapshot {
  status: GameStatus;
  scoreLeft: number;
  scoreRight: number;
  winner: "left" | "right" | null;
  /** Most recent meaningful event, used to drive screen-reader announcements. */
  announcement: string;
}

export interface PongOptions {
  maxScore?: number;
  onChange?: (snapshot: GameSnapshot) => void;
}

const WIDTH = 900;
const HEIGHT = 560;
const PADDLE_W = 14;
const PADDLE_H = 110;
const PADDLE_MARGIN = 28;
const BALL_RADIUS = 30;
const BASE_SPEED = 380; // px/sec
const SPEED_GAIN = 1.045; // multiplier per paddle hit
const MAX_SPEED = 980;
const PLAYER_SPEED = 620; // keyboard paddle speed px/sec
const AI_SPEED = 430; // px/sec (kept beatable)

/**
 * Self-contained Pong simulation + renderer. Owns its own requestAnimationFrame
 * loop and reports state changes through the onChange callback so the React
 * layer can keep an accessible, announced mirror of the score and status.
 */
export class PongEngine {
  readonly width = WIDTH;
  readonly height = HEIGHT;

  private ctx: CanvasRenderingContext2D;
  private head: HTMLImageElement;
  private maxScore: number;
  private onChange?: (snapshot: GameSnapshot) => void;

  private rafId = 0;
  private lastTs = 0;

  private status: GameStatus = "ready";
  private scoreLeft = 0;
  private scoreRight = 0;
  private winner: "left" | "right" | null = null;
  private announcement = "";

  private leftY = HEIGHT / 2 - PADDLE_H / 2;
  private rightY = HEIGHT / 2 - PADDLE_H / 2;
  private playerTargetY: number | null = null;
  private keyUp = false;
  private keyDown = false;

  private ballX = WIDTH / 2;
  private ballY = HEIGHT / 2;
  private ballVX = 0;
  private ballVY = 0;
  private spin = 0;

  constructor(canvas: HTMLCanvasElement, head: HTMLImageElement, options: PongOptions = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context");
    this.ctx = ctx;
    this.head = head;
    this.maxScore = options.maxScore ?? 7;
    this.onChange = options.onChange;

    canvas.width = WIDTH;
    canvas.height = HEIGHT;

    this.serve(Math.random() < 0.5 ? -1 : 1);
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
    this.emit();
  }

  // ---- public controls -----------------------------------------------------

  start(): void {
    if (this.status === "over") this.resetMatch();
    this.status = "playing";
    this.announce("Game on. Good luck!");
  }

  togglePause(): void {
    if (this.status === "playing") {
      this.status = "paused";
      this.announce("Paused.");
    } else if (this.status === "paused") {
      this.status = "playing";
      this.announce("Resumed.");
    }
  }

  resetMatch(): void {
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.winner = null;
    this.status = "ready";
    this.serve(Math.random() < 0.5 ? -1 : 1);
    this.announce("New match. Press space or Start to begin.");
  }

  setPlayerTarget(y: number | null): void {
    this.playerTargetY = y;
  }

  setKey(dir: "up" | "down", pressed: boolean): void {
    if (dir === "up") this.keyUp = pressed;
    else this.keyDown = pressed;
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
  }

  // ---- simulation -----------------------------------------------------------

  private serve(direction: -1 | 1): void {
    this.ballX = WIDTH / 2;
    this.ballY = HEIGHT / 2;
    const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // -45deg..45deg
    this.ballVX = direction * BASE_SPEED * Math.cos(angle);
    this.ballVY = BASE_SPEED * Math.sin(angle);
    this.spin = 0;
  }

  private loop(ts: number): void {
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 1 / 30) : 0;
    this.lastTs = ts;

    if (this.status === "playing") this.update(dt);
    this.render();

    this.rafId = requestAnimationFrame(this.loop);
  }

  private update(dt: number): void {
    // Player paddle: keyboard takes priority, otherwise follow pointer target.
    if (this.keyUp || this.keyDown) {
      const dir = (this.keyDown ? 1 : 0) - (this.keyUp ? 1 : 0);
      this.leftY += dir * PLAYER_SPEED * dt;
    } else if (this.playerTargetY != null) {
      this.leftY = this.playerTargetY - PADDLE_H / 2;
    }
    this.leftY = clamp(this.leftY, 0, HEIGHT - PADDLE_H);

    // AI paddle: tracks the ball with a capped speed and a small dead zone.
    const aiCenter = this.rightY + PADDLE_H / 2;
    const diff = this.ballY - aiCenter;
    if (Math.abs(diff) > 12) {
      this.rightY += Math.sign(diff) * Math.min(AI_SPEED * dt, Math.abs(diff));
    }
    this.rightY = clamp(this.rightY, 0, HEIGHT - PADDLE_H);

    // Ball.
    this.ballX += this.ballVX * dt;
    this.ballY += this.ballVY * dt;
    this.spin += this.ballVX * dt * 0.01;

    // Top / bottom walls.
    if (this.ballY - BALL_RADIUS < 0) {
      this.ballY = BALL_RADIUS;
      this.ballVY = Math.abs(this.ballVY);
    } else if (this.ballY + BALL_RADIUS > HEIGHT) {
      this.ballY = HEIGHT - BALL_RADIUS;
      this.ballVY = -Math.abs(this.ballVY);
    }

    this.handlePaddle("left");
    this.handlePaddle("right");

    // Scoring.
    if (this.ballX + BALL_RADIUS < 0) {
      this.score("right");
    } else if (this.ballX - BALL_RADIUS > WIDTH) {
      this.score("left");
    }
  }

  private handlePaddle(side: "left" | "right"): void {
    const isLeft = side === "left";
    const paddleX = isLeft ? PADDLE_MARGIN : WIDTH - PADDLE_MARGIN - PADDLE_W;
    const paddleY = isLeft ? this.leftY : this.rightY;
    const movingToward = isLeft ? this.ballVX < 0 : this.ballVX > 0;
    if (!movingToward) return;

    const withinX = isLeft
      ? this.ballX - BALL_RADIUS <= paddleX + PADDLE_W && this.ballX > paddleX
      : this.ballX + BALL_RADIUS >= paddleX && this.ballX < paddleX + PADDLE_W;
    const withinY =
      this.ballY + BALL_RADIUS >= paddleY && this.ballY - BALL_RADIUS <= paddleY + PADDLE_H;

    if (withinX && withinY) {
      // Deflect based on where the ball hits the paddle (classic Pong feel).
      const relative = (this.ballY - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2);
      const bounceAngle = clamp(relative, -1, 1) * (Math.PI / 3.2); // up to ~56deg
      const speed = Math.min(
        Math.hypot(this.ballVX, this.ballVY) * SPEED_GAIN,
        MAX_SPEED
      );
      const dir = isLeft ? 1 : -1;
      this.ballVX = dir * speed * Math.cos(bounceAngle);
      this.ballVY = speed * Math.sin(bounceAngle);
      this.ballX = isLeft
        ? paddleX + PADDLE_W + BALL_RADIUS
        : paddleX - BALL_RADIUS;
    }
  }

  private score(side: "left" | "right"): void {
    if (side === "left") this.scoreLeft += 1;
    else this.scoreRight += 1;

    if (this.scoreLeft >= this.maxScore || this.scoreRight >= this.maxScore) {
      this.winner = this.scoreLeft > this.scoreRight ? "left" : "right";
      this.status = "over";
      this.announce(
        this.winner === "left"
          ? `You win ${this.scoreLeft} to ${this.scoreRight}!`
          : `Computer wins ${this.scoreRight} to ${this.scoreLeft}. Press space to play again.`
      );
    } else {
      this.announce(
        `${side === "left" ? "You score" : "Computer scores"}. ${this.scoreLeft} to ${this.scoreRight}.`
      );
      // Serve toward whoever conceded.
      this.serve(side === "left" ? -1 : 1);
    }
    this.emit();
  }

  // ---- rendering ------------------------------------------------------------

  private render(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Court background.
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    grad.addColorStop(0, "#0d1b2a");
    grad.addColorStop(1, "#16263b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Center dashed net.
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 4;
    ctx.setLineDash([16, 18]);
    ctx.beginPath();
    ctx.moveTo(WIDTH / 2, 0);
    ctx.lineTo(WIDTH / 2, HEIGHT);
    ctx.stroke();
    ctx.setLineDash([]);

    // Scores.
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "bold 72px 'Trebuchet MS', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(String(this.scoreLeft), WIDTH / 2 - 90, 28);
    ctx.fillText(String(this.scoreRight), WIDTH / 2 + 90, 28);

    // Paddles.
    this.drawPaddle(PADDLE_MARGIN, this.leftY, "#5ee0c8");
    this.drawPaddle(WIDTH - PADDLE_MARGIN - PADDLE_W, this.rightY, "#ff7b9c");

    // Ball (the head).
    this.drawHead();

    // Status overlay.
    if (this.status !== "playing") this.drawOverlay();
  }

  private drawPaddle(x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    roundRect(ctx, x, y, PADDLE_W, PADDLE_H, 7);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  private drawHead(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.ballX, this.ballY);
    ctx.rotate(this.spin);

    // Soft glow disc behind the head so it reads as a ball.
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(94, 224, 200, 0.18)";
    ctx.fill();

    const size = BALL_RADIUS * 2.1;
    if (this.head.complete && this.head.naturalWidth > 0) {
      ctx.drawImage(this.head, -size / 2, -size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#f2f2f2";
      ctx.fill();
    }
    ctx.restore();
  }

  private drawOverlay(): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(5, 12, 22, 0.6)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let title = "";
    let subtitle = "Press Space or click Start";
    if (this.status === "ready") title = "Head Pong";
    else if (this.status === "paused") title = "Paused";
    else if (this.status === "over") {
      title = this.winner === "left" ? "You win!" : "Computer wins";
      subtitle = "Press Space to play again";
    }

    ctx.font = "bold 56px 'Trebuchet MS', system-ui, sans-serif";
    ctx.fillText(title, WIDTH / 2, HEIGHT / 2 - 18);
    ctx.font = "22px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText(subtitle, WIDTH / 2, HEIGHT / 2 + 34);
  }

  // ---- helpers --------------------------------------------------------------

  private announce(message: string): void {
    this.announcement = message;
    this.emit();
  }

  private emit(): void {
    this.onChange?.({
      status: this.status,
      scoreLeft: this.scoreLeft,
      scoreRight: this.scoreRight,
      winner: this.winner,
      announcement: this.announcement,
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
