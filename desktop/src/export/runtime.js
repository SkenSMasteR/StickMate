(function (root) {
  "use strict";

  const TAU = Math.PI * 2;

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function sceneLength(scene) {
    let length = 1;
    for (const layer of scene.layers) {
      length = Math.max(length, layer.length);
    }
    return length;
  }

  function heldKey(layer, frame) {
    let found = null;
    for (const key of layer.keys) {
      if (key.frame <= frame) {
        found = key;
      }
    }
    return found;
  }

  function evaluateLayer(layer, frame) {
    if (!layer.visible || frame >= layer.length) {
      return null;
    }
    const key = heldKey(layer, frame);
    if (!key) {
      return null;
    }
    let transform = { ...key.transform };
    if (key.tween) {
      const next = layer.keys[layer.keys.indexOf(key) + 1];
      if (next) {
        const span = next.frame - key.frame;
        if (span > 0) {
          const t = clamp((frame - key.frame) / span, 0, 1);
          transform = {
            x: transform.x + (next.transform.x - transform.x) * t,
            y: transform.y + (next.transform.y - transform.y) * t,
            rotation:
              transform.rotation + (next.transform.rotation - transform.rotation) * t,
            scale: transform.scale + (next.transform.scale - transform.scale) * t,
            opacity: transform.opacity + (next.transform.opacity - transform.opacity) * t
          };
        }
      }
    }
    return {
      opacity: clamp(layer.opacity * transform.opacity, 0, 1),
      transform,
      shapes: key.shapes
    };
  }

  function polygonVertices(x, y, w, h, sides) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const step = TAU / sides;
    const points = [];
    for (let index = 0; index < sides; index += 1) {
      const angle = -Math.PI / 2 + index * step;
      points.push({ x: cx + (w / 2) * Math.cos(angle), y: cy + (h / 2) * Math.sin(angle) });
    }
    return points;
  }

  function drawShape(ctx, shape) {
    if (shape.kind === "Stroke") {
      if (shape.points.length < 2) {
        return;
      }
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let index = 1; index < shape.points.length; index += 1) {
        ctx.lineTo(shape.points[index].x, shape.points[index].y);
      }
      ctx.stroke();
      return;
    }
    if (shape.kind === "Text") {
      ctx.fillStyle = shape.color;
      ctx.font = shape.size + "px " + shape.family;
      ctx.textBaseline = "hanging";
      ctx.fillText(shape.text, shape.x, shape.y);
      return;
    }
    if (shape.kind === "Path") {
      const nodes = shape.nodes;
      if (nodes.length === 0) {
        return;
      }
      if (shape.closed) {
        ctx.fillStyle = shape.fill;
      }
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = shape.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(nodes[0].point.x, nodes[0].point.y);
      const segments = shape.closed ? nodes.length : nodes.length - 1;
      for (let index = 0; index < segments; index += 1) {
        const a = nodes[index];
        const b = nodes[(index + 1) % nodes.length];
        const p1 = a.handle_out || a.point;
        const p2 = b.handle_in || b.point;
        ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, b.point.x, b.point.y);
      }
      if (shape.closed) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
      return;
    }
    ctx.fillStyle = shape.fill;
    ctx.strokeStyle = shape.stroke;
    ctx.lineWidth = shape.width;
    ctx.lineCap = "butt";
    ctx.lineJoin = shape.kind === "Polygon" ? "round" : "miter";
    ctx.beginPath();
    if (shape.kind === "Rect") {
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
    } else if (shape.kind === "Ellipse") {
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, shape.w / 2, shape.h / 2, 0, 0, TAU);
    } else {
      const points = polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides);
      ctx.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        ctx.lineTo(points[index].x, points[index].y);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }

  function load(project) {
    const scenes = project.scenes;
    const scale = project.scale;
    const startFrame = project.startFrame;
    const endFrame = project.endFrame;
    let frameCount = 0;
    if (endFrame === null) {
      for (const scene of scenes) {
        frameCount += sceneLength(scene);
      }
    } else {
      frameCount = endFrame - startFrame + 1;
    }
    let frame = 0;
    let playing = false;
    let loop = project.loop;
    let timer = null;
    let canvas = null;
    let ctx = null;
    let buffer = null;
    let bctx = null;

    function evaluate(at) {
      let scene = scenes[0];
      let local = at;
      if (endFrame !== null) {
        local = startFrame + at;
      } else {
        let index = 0;
        while (index < scenes.length - 1 && local >= sceneLength(scenes[index])) {
          local -= sceneLength(scenes[index]);
          index += 1;
        }
        scene = scenes[index];
      }
      const layers = [];
      for (const layer of scene.layers) {
        const evaluated = evaluateLayer(layer, local);
        if (evaluated) {
          layers.push(evaluated);
        }
      }
      return layers;
    }

    function render() {
      if (!ctx) {
        return;
      }
      const width = project.width;
      const height = project.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (project.background) {
        ctx.fillStyle = project.background;
        ctx.fillRect(0, 0, width, height);
      }
      const layers = evaluate(frame);
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index];
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.clearRect(0, 0, width, height);
        bctx.setTransform(scale, 0, 0, scale, 0, 0);
        bctx.translate(layer.transform.x, layer.transform.y);
        bctx.rotate((layer.transform.rotation * Math.PI) / 180);
        bctx.scale(layer.transform.scale, layer.transform.scale);
        for (const shape of layer.shapes) {
          drawShape(bctx, shape);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(buffer, 0, 0);
        ctx.globalAlpha = 1;
      }
    }

    function tick() {
      const next = frame + 1;
      if (next < frameCount) {
        frame = next;
      } else if (loop) {
        frame = 0;
      } else {
        frame = frameCount - 1;
        player.pause();
      }
      render();
    }

    const player = {
      mount(target) {
        canvas = target;
        canvas.width = project.width;
        canvas.height = project.height;
        ctx = canvas.getContext("2d");
        buffer = document.createElement("canvas");
        buffer.width = project.width;
        buffer.height = project.height;
        bctx = buffer.getContext("2d");
        render();
      },
      play() {
        if (playing || !ctx) {
          return;
        }
        playing = true;
        timer = setInterval(tick, 1000 / project.fps);
      },
      pause() {
        playing = false;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
      seek(value) {
        frame = clamp(Math.floor(value), 0, frameCount - 1);
        render();
      },
      setLoop(value) {
        loop = value;
      },
      get frame() {
        return frame;
      },
      get frameCount() {
        return frameCount;
      },
      get fps() {
        return project.fps;
      },
      get playing() {
        return playing;
      }
    };
    return player;
  }

  const api = { load };
  root.StickMate = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);