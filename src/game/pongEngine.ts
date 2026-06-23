export type GameStatus = "ready" | "playing" | "paused" | "over";

export interface GameSnapshot {
  status: GameStatus;
  scoreLeft: number;
  scoreRight: number;
  winner: "left" | "right" | null;
  /** Rounds the player (left) has left to fire. */
  playerAmmo: number;
  /** Rounds the opponent (right) has left to fire. */
  opponentAmmo: number;
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
const LASER_SPEED = 1400; // px/sec
const LASER_W = 26;
const LASER_H = 5;
const LASER_COOLDOWN = 0.18; // seconds between shots
const PADDLE_RESPAWN = 2.5; // seconds a destroyed paddle stays gone
const MAX_AMMO = 3;
const AMMO_REGEN = 2; // seconds to regain one round
const AI_FIRE_INTERVAL = 1.3; // base seconds between opponent shots

const PLAYER_COLOR = "#5ee0c8";
const OPPONENT_COLOR = "#ff7b9c";

interface Laser {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: -1 | 1; // +1 fired rightward (player), -1 fired leftward (opponent)
  bounces: number;
}

const LASER_SPREAD = (5 * Math.PI) / 180; // beams fire within ±5deg of straight
const LASER_MAX_BOUNCES = 8; // beams expire after this many wall ricochets

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // seconds remaining
  maxLife: number;
  size: number;
  color: string;
}

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

  private lasers: Laser[] = [];
  private particles: Particle[] = [];

  private leftCooldown = 0;
  private rightCooldown = 0;
  private leftAmmo = MAX_AMMO;
  private rightAmmo = MAX_AMMO;
  private leftRegen = 0; // seconds accumulated toward the next round
  private rightRegen = 0;
  private leftDestroyed = false;
  private rightDestroyed = false;
  private leftRespawnIn = 0;
  private rightRespawnIn = 0;
  private aiFireIn = AI_FIRE_INTERVAL;

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
    this.lasers = [];
    this.particles = [];
    this.leftCooldown = 0;
    this.rightCooldown = 0;
    this.leftAmmo = MAX_AMMO;
    this.rightAmmo = MAX_AMMO;
    this.leftRegen = 0;
    this.rightRegen = 0;
    this.leftDestroyed = false;
    this.rightDestroyed = false;
    this.leftRespawnIn = 0;
    this.rightRespawnIn = 0;
    this.aiFireIn = AI_FIRE_INTERVAL;
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

  /** Fire a laser from the player's paddle. Ignored unless the game is live. */
  firePlayerLaser(): void {
    this.fire("left");
  }

  /** Shared firing logic for either side. Gated by status, cooldown, ammo and life. */
  private fire(side: "left" | "right"): void {
    if (this.status !== "playing") return;
    const isLeft = side === "left";
    if (isLeft ? this.leftDestroyed : this.rightDestroyed) return;
    if ((isLeft ? this.leftCooldown : this.rightCooldown) > 0) return;
    if ((isLeft ? this.leftAmmo : this.rightAmmo) <= 0) return;

    const dir: -1 | 1 = isLeft ? 1 : -1;
    const muzzleX = isLeft ? PADDLE_MARGIN + PADDLE_W : WIDTH - PADDLE_MARGIN - PADDLE_W;
    const muzzleY = (isLeft ? this.leftY : this.rightY) + PADDLE_H / 2;

    // Fire roughly straight, with a small random ±5deg spread.
    const angle = (Math.random() * 2 - 1) * LASER_SPREAD;
    const laser: Laser = {
      x: muzzleX,
      y: muzzleY,
      vx: dir * LASER_SPEED * Math.cos(angle),
      vy: LASER_SPEED * Math.sin(angle),
      dir,
      bounces: 0,
    };

    if (isLeft) {
      this.leftAmmo -= 1;
      this.leftCooldown = LASER_COOLDOWN;
    } else {
      this.rightAmmo -= 1;
      this.rightCooldown = LASER_COOLDOWN;
    }
    this.lasers.push(laser);
    this.emit();
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
    this.regenAmmo(dt);
    if (this.leftCooldown > 0) this.leftCooldown = Math.max(0, this.leftCooldown - dt);
    if (this.rightCooldown > 0) this.rightCooldown = Math.max(0, this.rightCooldown - dt);

    // Player paddle: keyboard takes priority, otherwise follow pointer target.
    // Skipped while destroyed; it respawns after a short delay.
    if (this.leftDestroyed) {
      this.leftRespawnIn -= dt;
      if (this.leftRespawnIn <= 0) {
        this.leftDestroyed = false;
        this.announce("Your paddle is back online.");
      }
    } else {
      if (this.keyUp || this.keyDown) {
        const dir = (this.keyDown ? 1 : 0) - (this.keyUp ? 1 : 0);
        this.leftY += dir * PLAYER_SPEED * dt;
      } else if (this.playerTargetY != null) {
        this.leftY = this.playerTargetY - PADDLE_H / 2;
      }
      this.leftY = clamp(this.leftY, 0, HEIGHT - PADDLE_H);
    }

    // AI paddle: tracks the ball with a capped speed and a small dead zone.
    // Skipped while destroyed; it respawns after a short delay.
    if (this.rightDestroyed) {
      this.rightRespawnIn -= dt;
      if (this.rightRespawnIn <= 0) {
        this.rightDestroyed = false;
        this.announce("Opponent paddle restored.");
      }
    } else {
      const aiCenter = this.rightY + PADDLE_H / 2;
      const diff = this.ballY - aiCenter;
      if (Math.abs(diff) > 12) {
        this.rightY += Math.sign(diff) * Math.min(AI_SPEED * dt, Math.abs(diff));
      }
      this.rightY = clamp(this.rightY, 0, HEIGHT - PADDLE_H);
      this.updateAiFire(dt);
    }

    // Lasers.
    this.updateLasers(dt);

    // Explosion debris.
    this.updateParticles(dt);

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

    if (!this.leftDestroyed) this.handlePaddle("left");
    if (!this.rightDestroyed) this.handlePaddle("right");

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

  private regenAmmo(dt: number): void {
    let changed = false;
    if (this.leftAmmo < MAX_AMMO) {
      this.leftRegen += dt;
      if (this.leftRegen >= AMMO_REGEN) {
        this.leftRegen -= AMMO_REGEN;
        this.leftAmmo += 1;
        changed = true;
      }
    } else {
      this.leftRegen = 0;
    }
    if (this.rightAmmo < MAX_AMMO) {
      this.rightRegen += dt;
      if (this.rightRegen >= AMMO_REGEN) {
        this.rightRegen -= AMMO_REGEN;
        this.rightAmmo += 1;
        changed = true;
      }
    } else {
      this.rightRegen = 0;
    }
    if (changed) this.emit();
  }

  private updateAiFire(dt: number): void {
    this.aiFireIn -= dt;
    if (this.aiFireIn > 0) return;
    this.aiFireIn = AI_FIRE_INTERVAL + Math.random() * AI_FIRE_INTERVAL;
    // Beams bounce, so there's no straight line to wait for — just fire when the
    // player is alive and we have a round. (fire() enforces ammo/cooldown/status.)
    if (!this.leftDestroyed) this.fire("right");
  }

  private updateLasers(dt: number): void {
    const hw = LASER_W / 2;
    const leftPaddleX = PADDLE_MARGIN;
    const rightPaddleX = WIDTH - PADDLE_MARGIN - PADDLE_W;
    const next: Laser[] = [];

    for (const laser of this.lasers) {
      laser.x += laser.vx * dt;
      laser.y += laser.vy * dt;

      // Bounce off the top / bottom walls, just like the ball.
      if (laser.y - LASER_H / 2 < 0) {
        laser.y = LASER_H / 2;
        laser.vy = Math.abs(laser.vy);
        laser.bounces += 1;
      } else if (laser.y + LASER_H / 2 > HEIGHT) {
        laser.y = HEIGHT - LASER_H / 2;
        laser.vy = -Math.abs(laser.vy);
        laser.bounces += 1;
      }

      // Bounce off the left / right back walls.
      if (laser.x - hw < 0) {
        laser.x = hw;
        laser.vx = Math.abs(laser.vx);
        laser.bounces += 1;
      } else if (laser.x + hw > WIDTH) {
        laser.x = WIDTH - hw;
        laser.vx = -Math.abs(laser.vx);
        laser.bounces += 1;
      }

      // Hit the ball? Knock it away and spend the beam.
      const bdx = this.ballX - laser.x;
      const bdy = this.ballY - laser.y;
      if (Math.hypot(bdx, bdy) <= BALL_RADIUS) {
        this.bounceBallOffBeam(laser);
        continue;
      }

      // Hit a paddle? Which one depends on the direction of travel, so a beam
      // that ricochets off a back wall can come back and strike the firer.
      const movingRight = laser.vx > 0;
      const withinY = (py: number) => laser.y >= py && laser.y <= py + PADDLE_H;
      if (
        movingRight &&
        !this.rightDestroyed &&
        laser.x + hw >= rightPaddleX &&
        laser.x - hw <= rightPaddleX + PADDLE_W &&
        withinY(this.rightY)
      ) {
        this.destroyPaddle("right");
        continue;
      }
      if (
        !movingRight &&
        !this.leftDestroyed &&
        laser.x - hw <= leftPaddleX + PADDLE_W &&
        laser.x + hw >= leftPaddleX &&
        withinY(this.leftY)
      ) {
        this.destroyPaddle("left");
        continue;
      }

      // Expire once a beam has ricocheted too many times.
      if (laser.bounces <= LASER_MAX_BOUNCES) next.push(laser);
    }
    this.lasers = next;
  }

  private bounceBallOffBeam(laser: Laser): void {
    // Reflect the ball about the normal pointing from the beam to the ball,
    // then add a little of the beam's punch so the hit reads as a knock.
    const dx = this.ballX - laser.x;
    const dy = this.ballY - laser.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;

    const vDotN = this.ballVX * nx + this.ballVY * ny;
    if (vDotN < 0) {
      this.ballVX -= 2 * vDotN * nx;
      this.ballVY -= 2 * vDotN * ny;
    }
    // Nudge it along the beam's direction and cap to the usual speed limit.
    this.ballVX += laser.vx * 0.15;
    this.ballVY += laser.vy * 0.15;
    const speed = Math.hypot(this.ballVX, this.ballVY);
    if (speed > MAX_SPEED) {
      this.ballVX = (this.ballVX / speed) * MAX_SPEED;
      this.ballVY = (this.ballVY / speed) * MAX_SPEED;
    }

    // Push the ball clear of the beam so it can't re-trigger next frame.
    this.ballX = laser.x + nx * (BALL_RADIUS + 1);
    this.ballY = laser.y + ny * (BALL_RADIUS + 1);

    this.spawnParticles(laser.x, laser.y, laser.dir > 0 ? "#ffe66d" : "#ff5a5a", 10, 8, 8);
  }

  private destroyPaddle(side: "left" | "right"): void {
    if (side === "left") {
      this.leftDestroyed = true;
      this.leftRespawnIn = PADDLE_RESPAWN;
      this.spawnParticles(PADDLE_MARGIN + PADDLE_W / 2, this.leftY + PADDLE_H / 2, PLAYER_COLOR);
      this.announce("You were hit! Your paddle was destroyed.");
    } else {
      this.rightDestroyed = true;
      this.rightRespawnIn = PADDLE_RESPAWN;
      this.spawnParticles(
        WIDTH - PADDLE_MARGIN - PADDLE_W / 2,
        this.rightY + PADDLE_H / 2,
        OPPONENT_COLOR
      );
      this.announce("Direct hit! Opponent paddle destroyed.");
    }
  }

  private spawnParticles(
    cx: number,
    cy: number,
    color: string,
    count = 32,
    spreadX = PADDLE_W,
    spreadY = PADDLE_H
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 120 + Math.random() * 360;
      const life = 0.5 + Math.random() * 0.6;
      this.particles.push({
        // Scatter across the impact area so the burst reads as a shatter / spark.
        x: cx + (Math.random() - 0.5) * spreadX,
        y: cy + (Math.random() - 0.5) * spreadY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        size: 2 + Math.random() * 4,
        color,
      });
    }
  }

  private updateParticles(dt: number): void {
    if (this.particles.length === 0) return;
    const next: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += 520 * dt; // gravity
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      next.push(p);
    }
    this.particles = next;
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
    if (!this.leftDestroyed) {
      this.drawPaddle(PADDLE_MARGIN, this.leftY, PLAYER_COLOR);
    }
    if (!this.rightDestroyed) {
      this.drawPaddle(WIDTH - PADDLE_MARGIN - PADDLE_W, this.rightY, OPPONENT_COLOR);
    }

    // Lasers.
    this.drawLasers();

    // Explosion debris.
    this.drawParticles();

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

  private drawLasers(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowBlur = 16;
    for (const laser of this.lasers) {
      // Player beams are yellow, opponent beams are red.
      const color = laser.dir > 0 ? "#ffe66d" : "#ff5a5a";
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.save();
      ctx.translate(laser.x, laser.y);
      ctx.rotate(Math.atan2(laser.vy, laser.vx));
      ctx.fillRect(-LASER_W / 2, -LASER_H / 2, LASER_W, LASER_H);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawParticles(): void {
    if (this.particles.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowBlur = 12;
    for (const p of this.particles) {
      const t = p.life / p.maxLife; // 1 -> 0
      // Glow in the paddle's color, dimming toward the end of its life.
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
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
      playerAmmo: this.leftAmmo,
      opponentAmmo: this.rightAmmo,
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
