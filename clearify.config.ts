import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Framer Clone',
  docsDir: './docs',
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
