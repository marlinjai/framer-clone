// A worker that allocates until it passes its heap limit: the runner must stop it as out of memory.
const keep = [];
for (;;) keep.push(new Array(1_000_000).fill(Math.random()));
