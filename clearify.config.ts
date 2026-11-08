import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Framer Clone',
  docsDir: './docs',
  // The docs are published through the ERP Suite hub, not a site of their own, so there is no URL for
  // clearify 2 to write llms.txt against; that output stays off.
  generateLlmsTxt: false,
  hubProject: {
    hubUrl: 'https://docs.lumitra.co',
    hubName: 'ERP Suite',
    description: 'Visual website builder with infinite canvas',
    status: 'beta',
    icon: '🎨',
    tags: ['app', 'editor'],
    group: 'Applications',
  },
});
