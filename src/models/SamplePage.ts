// src/models/SamplePage.ts
// Sample page implementation using the PageModel
import { createPage } from './PageModel';
import { sampleComponentTree } from './SampleComponentTree';

// Create a sample page with our component tree
export const samplePage = createPage(
  'sample-page',
  'home',
  'Framer Clone - Sample Page',
  'A sample page demonstrating our ComponentModel and PageModel integration with responsive breakpoints.'
);

// Set the root component to our sample tree
samplePage.setRootComponent(sampleComponentTree);

// Add some additional metadata
samplePage.updateMetadata({
  keywords: ['framer', 'clone', 'design', 'tool', 'responsive'],
  ogTitle: 'Framer Clone - Interactive Design Tool',
  ogDescription: 'Build responsive designs with our visual component editor',
  canonicalUrl: 'https://myframeclone.com/home'
});

// Add custom page settings
samplePage.updateSettings({
  theme: 'light',
  showGrid: true,
  snapToGrid: true,
  gridSize: 20,
  showRulers: true,
  backgroundColor: '#f8fafc'
});


export default samplePage;
