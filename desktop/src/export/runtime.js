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

  const LINEAR_EASING = { x1: 0, y1: 0, x2: 1, y2: 1 };

  function cubicValue(p1, p2, u) {
    const inv = 1 - u;
    return 3 * inv * inv * u * p1 + 3 * inv * u * u * p2 + u * u * u;
  }

  function cubicSlope(p1, p2, u) {
    const inv = 1 - u;
    return 3 * inv * inv * p1 + 6 * inv * u * (p2 - p1) + 3 * u * u * (1 - p2);
  }

  function curveUnit(x1, x2, target) {
    let u = target;
    for (let steps = 0; steps < 8; steps += 1) {
      const error = cubicValue(x1, x2, u) - target;
      if (Math.abs(error) <= 1e-7) {
        return u;
      }
      const slope = cubicSlope(x1, x2, u);
      if (Math.abs(slope) <= 1e-7) {
        break;
      }
      const next = u - error / slope;
      if (next <= 0 || next >= 1) {
        break;
      }
      u = next;
    }
    let low = 0;
    let high = 1;
    for (let index = 0; index < 32; index += 1) {
      const middle = (low + high) / 2;
      if (cubicValue(x1, x2, middle) < target) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return (low + high) / 2;
  }

  function easeProgress(t, easing) {
    if (t <= 0) {
      return 0;
    }
    if (t >= 1) {
      return 1;
    }
    const curve = easing || LINEAR_EASING;
    if (curve.x1 === curve.y1 && curve.x2 === curve.y2) {
      return t;
    }
    return cubicValue(curve.y1, curve.y2, curveUnit(curve.x1, curve.x2, t));
  }

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  function mixPoint(a, b, t) {
    return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
  }

  function mixBytes(value) {
    if (typeof value !== "string" || value.charAt(0) !== "#") {
      return null;
    }
    const hex = value.slice(1);
    if (!/^[0-9a-fA-F]{3}$/.test(hex) && !/^[0-9a-fA-F]{6}$/.test(hex)) {
      return null;
    }
    if (hex.length === 3) {
      return [
        parseInt(hex.charAt(0), 16) * 17,
        parseInt(hex.charAt(1), 16) * 17,
        parseInt(hex.charAt(2), 16) * 17
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ];
  }

  function mixColor(a, b, t) {
    const from = mixBytes(a);
    const to = mixBytes(b);
    if (!from || !to) {
      return a;
    }
    let out = "#";
    for (let index = 0; index < 3; index += 1) {
      out += Math.floor(mix(from[index], to[index], t) + 0.5)
        .toString(16)
        .padStart(2, "0");
    }
    return out;
  }

  function mixHandle(a, b, aPoint, bPoint, t) {
    if (!a && !b) {
      return null;
    }
    return mixPoint(a || aPoint, b || bPoint, t);
  }

  function mixAffine(a, b, t) {
    const names = ["a", "b", "c", "d", "e", "f"];
    const out = {};
    for (const name of names) {
      out[name] = mix(a[name], b[name], t);
    }
    return out;
  }

  function gradientOf(shape) {
    return shape.gradient || null;
  }

  function mixStops(a, b, t) {
    return a.map((stop, index) => ({
      offset: mix(stop.offset, b[index].offset, t),
      color: mixColor(stop.color, b[index].color, t)
    }));
  }

  function mixGradient(a, b, t) {
    if (a && b && a.kind === b.kind && a.stops.length === b.stops.length) {
      const stops = mixStops(a.stops, b.stops, t);
      return a.kind === "linear"
        ? { kind: "linear", angle: mix(a.angle, b.angle, t), stops: stops }
        : { kind: "radial", stops: stops };
    }
    return a || null;
  }

  function gradientsMixable(a, b) {
    if (!a && !b) {
      return true;
    }
    return !!a && !!b && a.kind === b.kind && a.stops.length === b.stops.length;
  }

  function gradientBox(shape) {
    if (shape.kind === "Path") {
      var xs = [];
      var ys = [];
      for (var index = 0; index < shape.nodes.length; index += 1) {
        var node = shape.nodes[index];
        xs.push(node.point.x);
        ys.push(node.point.y);
        if (node.handle_in) {
          xs.push(node.handle_in.x);
          ys.push(node.handle_in.y);
        }
        if (node.handle_out) {
          xs.push(node.handle_out.x);
          ys.push(node.handle_out.y);
        }
      }
      var left = Math.min.apply(null, xs);
      var top = Math.min.apply(null, ys);
      return {
        x: left,
        y: top,
        w: Math.max.apply(null, xs) - left,
        h: Math.max.apply(null, ys) - top
      };
    }
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }

  function gradientGeometry(box, gradient) {
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    if (gradient.kind === "radial") {
      return [cx, cy, cx, cy, Math.hypot(box.w / 2, box.h / 2)];
    }
    var rad = (gradient.angle * Math.PI) / 180;
    var dx = Math.cos(rad);
    var dy = Math.sin(rad);
    var half = (Math.abs(dx) * box.w + Math.abs(dy) * box.h) / 2;
    return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, 0];
  }

  function fillStyle(ctx, shape) {
    var gradient = gradientOf(shape);
    if (!gradient) {
      return shape.fill;
    }
    var parts = gradientGeometry(gradientBox(shape), gradient);
    var paint =
      gradient.kind === "linear"
        ? ctx.createLinearGradient(parts[0], parts[1], parts[2], parts[3])
        : ctx.createRadialGradient(parts[0], parts[1], 0, parts[2], parts[3], parts[4]);
    for (var index = 0; index < gradient.stops.length; index += 1) {
      var stop = gradient.stops[index];
      paint.addColorStop(stop.offset, stop.color);
    }
    return paint;
  }

  function mixable(a, b) {
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === "Rect" || a.kind === "Ellipse") {
      return gradientsMixable(gradientOf(a), gradientOf(b));
    }
    if (a.kind === "Text") {
      return true;
    }
    if (a.kind === "Polygon") {
      return a.sides === b.sides && gradientsMixable(gradientOf(a), gradientOf(b));
    }
    if (a.kind === "Stroke") {
      return a.points.length === b.points.length && a.points.length > 1;
    }
    if (a.kind === "Path") {
      return (
        a.closed === b.closed &&
        a.nodes.length === b.nodes.length &&
        a.nodes.length > 1 &&
        gradientsMixable(gradientOf(a), gradientOf(b))
      );
    }
    if (a.kind === "Group") {
      return (
        a.children.length > 0 &&
        a.children.length === b.children.length &&
        a.children.every((child, index) => mixable(child, b.children[index]))
      );
    }
    return false;
  }

  function mixShape(a, b, t) {
    if (t <= 0) {
      return a;
    }
    if (t >= 1) {
      return b;
    }
    if (a.kind !== b.kind) {
      return a;
    }
    if (a.kind === "Group") {
      if (!mixable(a, b)) {
        return a;
      }
      return {
        kind: "Group",
        children: a.children.map((child, index) => mixShape(child, b.children[index], t))
      };
    }
    if (a.kind === "Rect" || a.kind === "Ellipse" || a.kind === "Polygon") {
      if (a.kind === "Polygon" && a.sides !== b.sides) {
        return a;
      }
      const box = {
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
        w: mix(a.w, b.w, t),
        h: mix(a.h, b.h, t),
        fill: mixColor(a.fill, b.fill, t),
        stroke: mixColor(a.stroke, b.stroke, t),
        width: mix(a.width, b.width, t),
        gradient: mixGradient(gradientOf(a), gradientOf(b), t)
      };
      if (a.kind === "Polygon") {
        box.sides = a.sides;
      }
      return Object.assign({ kind: a.kind }, box);
    }
    if (a.kind === "Stroke") {
      if (a.points.length !== b.points.length || a.points.length < 2) {
        return a;
      }
      return {
        kind: "Stroke",
        points: a.points.map((point, index) => mixPoint(point, b.points[index], t)),
        color: mixColor(a.color, b.color, t),
        width: mix(a.width, b.width, t)
      };
    }
    if (a.kind === "Path") {
      if (
        a.closed !== b.closed ||
        a.nodes.length !== b.nodes.length ||
        a.nodes.length < 2
      ) {
        return a;
      }
      return {
        kind: "Path",
        nodes: a.nodes.map((node, index) => {
          const other = b.nodes[index];
          return {
            point: mixPoint(node.point, other.point, t),
            handle_in: mixHandle(node.handle_in, other.handle_in, node.point, other.point, t),
            handle_out: mixHandle(
              node.handle_out,
              other.handle_out,
              node.point,
              other.point,
              t
            )
          };
        }),
        closed: a.closed,
        fill: mixColor(a.fill, b.fill, t),
        stroke: mixColor(a.stroke, b.stroke, t),
        width: mix(a.width, b.width, t),
        gradient: mixGradient(gradientOf(a), gradientOf(b), t)
      };
    }
    if (a.kind === "Text") {
      return {
        kind: "Text",
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
        text: a.text,
        size: mix(a.size, b.size, t),
        family: a.family,
        color: mixColor(a.color, b.color, t),
        matrix:
          a.matrix && b.matrix
            ? mixAffine(a.matrix, b.matrix, t)
            : a.matrix || b.matrix || null
      };
    }
    return a;
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
    let shapes = key.shapes;
    if (key.tween) {
      const next = layer.keys[layer.keys.indexOf(key) + 1];
      if (next) {
        const span = next.frame - key.frame;
        if (span > 0) {
          const t = easeProgress(clamp((frame - key.frame) / span, 0, 1), key.easing);
          transform = {
            x: transform.x + (next.transform.x - transform.x) * t,
            y: transform.y + (next.transform.y - transform.y) * t,
            rotation:
              transform.rotation + (next.transform.rotation - transform.rotation) * t,
            scale: transform.scale + (next.transform.scale - transform.scale) * t,
            opacity: transform.opacity + (next.transform.opacity - transform.opacity) * t
          };
          shapes = key.shapes.map((shape, position) => {
            const other = next.shapes[position];
            return other ? mixShape(shape, other, t) : shape;
          });
        }
      }
    }
    return {
      opacity: clamp(layer.opacity * transform.opacity, 0, 1),
      transform,
      shapes
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
    if (shape.kind === "Group") {
      for (const child of shape.children) {
        drawShape(ctx, child);
      }
      return;
    }
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
      ctx.save();
      if (shape.matrix) {
        const m = shape.matrix;
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      }
      ctx.fillStyle = shape.color;
      ctx.font = shape.size + "px " + shape.family;
      ctx.textBaseline = "hanging";
      ctx.fillText(shape.text, shape.x, shape.y);
      ctx.restore();
      return;
    }
    if (shape.kind === "Path") {
      const nodes = shape.nodes;
      if (nodes.length === 0) {
        return;
      }
      if (shape.closed) {
        ctx.fillStyle = fillStyle(ctx, shape);
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
    ctx.fillStyle = fillStyle(ctx, shape);
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