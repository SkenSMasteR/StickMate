use serde::{Deserialize, Serialize};

use crate::document::Point;

pub const PATH_STEPS: usize = 16;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PathNode {
    pub point: Point,
    pub handle_in: Option<Point>,
    pub handle_out: Option<Point>,
}

pub fn flatten_path(nodes: &[PathNode], closed: bool) -> Vec<Point> {
    let mut out = Vec::new();
    let Some(first) = nodes.first() else {
        return out;
    };
    out.push(first.point.clone());
    let segments = if closed {
        nodes.len()
    } else {
        nodes.len() - 1
    };
    for index in 0..segments {
        let a = &nodes[index];
        let b = &nodes[(index + 1) % nodes.len()];
        let p0 = &a.point;
        let p1 = a.handle_out.as_ref().unwrap_or(p0);
        let p3 = &b.point;
        let p2 = b.handle_in.as_ref().unwrap_or(p3);
        for step in 1..=PATH_STEPS {
            let t = step as f64 / PATH_STEPS as f64;
            let u = 1.0 - t;
            out.push(Point {
                x: u * u * u * p0.x
                    + 3.0 * u * u * t * p1.x
                    + 3.0 * u * t * t * p2.x
                    + t * t * t * p3.x,
                y: u * u * u * p0.y
                    + 3.0 * u * u * t * p1.y
                    + 3.0 * u * t * t * p2.y
                    + t * t * t * p3.y,
            });
        }
    }
    out
}