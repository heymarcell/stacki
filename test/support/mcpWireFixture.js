// What the wire scenarios need that the shared harness fixture does not have.
//
// test/agent-harness.js builds a good Astro project — pages, components, a
// layout, props, a repeated map, styles, CSS variables, JSON data, a content
// config. Three things were missing, and their absence was quietly turning
// real assertions into weak ones:
//
//   A DYNAMIC ROUTE. Without one, `page.dynamic_paths` truthfully answers
//   `paths: []`, and a scenario asserting "it answered" proves nothing about
//   whether Stacki can enumerate paths at all.
//
//   A REAL IMAGE. `asset.dimensions` on robots.txt answers `dims: null`,
//   correctly. To assert dimensions you need something that HAS dimensions,
//   so this ships a real 6x3 PNG whose size is known here.
//
//   A SECOND ASSET AND A CANARY. So move/rename/delete have something to move
//   that is not load-bearing, and read_text has an exact string to find.
//
// These are additions to the shared fixture rather than edits of it: every
// other suite that uses agent-harness.js keeps the project it expects.

// A real PNG — 6 wide, 3 high, generated rather than pasted from anywhere.
const DOT_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAADCAIAAAA/Y+msAAAAEUlEQVR4nGP4z8CAhtD52IUAEUQR788PiNkAAAAASUVORK5CYII=';
const DOT_WIDTH = 6;
const DOT_HEIGHT = 3;

// Exact text, so asset.read_text can assert content rather than "a string".
const ROBOTS_CANARY = 'STACKI_WIRE_CANARY_9f2a';

const EXTRA = {
  // A dynamic route with paths Stacki can actually enumerate.
  'src/pages/notes/[slug].astro': `---
export function getStaticPaths() {
  return [{ params: { slug: 'first' } }, { params: { slug: 'second' } }];
}
const { slug } = Astro.params;
---
<h2>{slug}</h2>
`,
  'public/robots.txt': `User-agent: *\nDisallow: /admin\n# ${ROBOTS_CANARY}\n`,
  'public/spare.txt': 'a file that exists to be moved and renamed\n',
};

/** Written after the project exists, because it is binary. */
function writeBinary(fs, path, root) {
  fs.mkdirSync(path.join(root, 'public', 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'images', 'dot.png'), Buffer.from(DOT_PNG_BASE64, 'base64'));
}

module.exports = { EXTRA, writeBinary, DOT_WIDTH, DOT_HEIGHT, ROBOTS_CANARY };
