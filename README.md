# Framer Clone - Professional Design Tool

A high-performance, production-ready design tool built with Next.js, TypeScript, and MobX State Tree. This project replicates Framer's core functionality with modern web technologies and clean architecture.

## ✨ Features

### 🎯 **Core Functionality**
- **Infinite Canvas**: High-performance pan and zoom with 60fps smooth transforms
- **Drag & Drop**: Real-time element positioning with pixel-perfect snapping
- **Responsive Design**: Multi-breakpoint editing with Desktop, Tablet, and Mobile viewports
- **Component System**: Unified architecture for floating elements and viewport components
- **Cross-Viewport Highlighting**: Select components and see them highlighted across all breakpoints

### 🎨 **Professional Design Tools**
- **Visual Selection**: Green overlay with resize handles (Framer-style UX)
- **Breakpoint-Aware Styling**: Edit colors and styles per breakpoint
- **Real-Time Updates**: See changes instantly across all viewports
- **Pixel Snapping**: Clean integer coordinates for professional layouts
- **Canvas Deselection**: Click empty space to clear selections

### 🏗️ **Architecture Highlights**
- **MobX State Tree**: Predictable state management with time-travel debugging
- **Modular Components**: Clean separation of concerns with dedicated panels
- **Performance Optimized**: Direct DOM manipulation for smooth interactions
- **TypeScript**: Full type safety throughout the codebase
- **Zero Prop Drilling**: Components access state directly via stores

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd framer-clone

# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the design tool in action.

## 🎮 How to Use

### **Basic Navigation**
- **Pan Canvas**: Scroll to pan around the infinite canvas
- **Zoom**: Hold `⌘` (Mac) or `Ctrl` (Windows/Linux) + scroll to zoom
- **Tool Selection**: Use toolbar at bottom to switch between Grab and Select tools

### **Working with Elements**

#### **Selecting Elements**
1. Use **Select tool** (cursor icon)
2. Click on any element to select it
3. See green highlight with resize handles
4. View properties in right sidebar

#### **Dragging Elements**
1. Select an element
2. Click and drag to move it around the canvas
3. Elements snap to pixel boundaries automatically
4. Overlay disappears during drag (clean UX)

#### **Viewport Management**
1. **Drag Viewports**: Move Desktop, Tablet, Mobile frames around canvas
2. **Edit Properties**: Select viewport to edit min-width and dimensions
3. **Breakpoint Context**: Select viewport to edit styles for that breakpoint

### **Responsive Styling**

#### **Breakpoint-Aware Colors**
1. Select a component (e.g., header inside Desktop viewport)
2. Select a viewport to set breakpoint context
3. Use color pickers in right sidebar
4. See blue badge indicating which breakpoint you're editing
5. Switch viewports to set different colors per breakpoint

#### **Style Inheritance**
- **Base Values**: Set without viewport context for global styles
- **Breakpoint Overrides**: Select viewport first, then edit for that breakpoint
- **Automatic Fallback**: Styles fall back from specific → base → default

### **Layers Panel**
1. **Switch to Layers Tab**: Click "Layers" in left sidebar
2. **Collapsible Viewports**: Each viewport (Desktop, Tablet, Mobile) is its own tree
3. **Component Hierarchy**: Expand viewports to see app component tree
4. **Floating Elements**: Separate section for canvas-level elements
5. **Visibility/Lock Controls**: Eye and lock icons for each element

## 🏗️ Architecture

### **State Management**
```
RootStore
├── ProjectStore (Domain Logic)
│   └── Projects → Pages → Components
└── EditorUIStore (UI State)
    ├── Current Selections
    ├── Tool State
    └── Panel Visibility
```

### **Component Architecture**
```
Canvas (Infinite Pan/Zoom)
├── ResponsivePageRenderer
│   ├── Viewport Nodes (Desktop, Tablet, Mobile)
│   └── Floating Elements
├── HudSurface (Selection Overlays)
├── LeftSidebar
│   ├── ComponentsPanel (Component Library)
│   └── LayersPanel (Hierarchical Tree)
└── RightSidebar
    ├── BreakpointPropertiesPanel
    ├── ComponentPropertiesPanel
    └── ResponsiveStylingPanel
```

### **Key Design Patterns**

#### **Ground Wrapper System**
Each canvas element uses individual positioning wrappers (like Framer):
```typescript
<GroundWrapper x={100} y={200} scale={1} rotation={0}>
  <ComponentRenderer component={element} />
</GroundWrapper>
```

#### **Responsive Style Maps**
Styles automatically convert to breakpoint-aware maps:
```javascript
// Simple value
backgroundColor: '#ffffff'

// Becomes responsive map
backgroundColor: {
  base: '#ffffff',
  'desktop-id': '#ff0000',
  'mobile-id': '#00ff00'
}
```

#### **Transform Context**
High-performance canvas transforms with zero React re-renders:
```typescript
// Direct DOM manipulation for 60fps performance
transformState.current.zoom = newZoom;
applyTransform(); // Direct CSS transform
notifySubscribers(); // Update overlays
```

## 🛠️ Technical Stack

### **Frontend**
- **Next.js 15**: React framework with App Router
- **TypeScript**: Full type safety
- **Tailwind CSS**: Utility-first styling
- **Radix UI**: Accessible component primitives

### **State Management**
- **MobX State Tree**: Predictable state with snapshots and patches
- **Observer Pattern**: Reactive components with automatic re-rendering
- **Ref-based Performance**: Transform state stored in refs for smooth animations

### **Performance**
- **Direct DOM Manipulation**: Bypass React for real-time transforms
- **GPU Optimization**: CSS `will-change` and `isolation` properties
- **Efficient Event Handling**: Native event listeners for wheel/mouse events
- **Minimal Re-renders**: Strategic use of refs and subscriptions

## 🎯 Key Features Deep Dive

### **1. Infinite Canvas System**
- **Camera Transform**: Single transform wrapper for all content
- **Grid Background**: Fixed grid that doesn't transform (stays in viewport)
- **Zoom-Aware Interactions**: All mouse interactions account for current zoom level
- **Performance**: 60fps smooth pan/zoom without React re-renders

### **2. Drag & Drop System**
- **Pixel Snapping**: All positions snap to integer coordinates
- **Zoom Compensation**: Screen deltas converted to canvas coordinates
- **Visual Feedback**: Opacity changes and cursor updates during drag
- **State Management**: Proper MST actions for all position updates

### **3. Responsive Breakpoint System**
- **Viewport Nodes**: Desktop (1280px+), Tablet (768px), Mobile (320px)
- **Breakpoint Context**: Visual indicators show which breakpoint you're editing
- **Style Inheritance**: Proper fallback chain from specific → base → default
- **Real-Time Preview**: See changes instantly across all viewports

### **4. Component Hierarchy**
- **App Component Tree**: Deployable component structure (like React tree)
- **Floating Elements**: Canvas-level positioned elements
- **Parent Tracking**: Automatic parent-child relationship management
- **Cross-Viewport Sync**: Same component highlighted across multiple viewports

### **5. Professional UX Patterns**
- **Framer-Style Selection**: Overlay disappears during drag operations
- **Context-Aware Panels**: Right sidebar shows relevant controls based on selection
- **Unified Colors**: All selections use consistent green highlighting
- **Empty Space Deselection**: Click canvas to clear selections

## 🔧 Development

### **Project Structure**
```
src/
├── app/                    # Next.js App Router
├── components/
│   ├── sidebars/          # Modular sidebar components
│   │   ├── left/          # Components and Layers panels
│   │   └── right/         # Properties and Styling panels
│   ├── Canvas.tsx         # Main infinite canvas
│   ├── HudSurface.tsx     # Selection overlays
│   └── ...
├── stores/                # MobX State Tree stores
├── models/                # Domain models (Component, Page, Project)
├── contexts/              # React contexts (Transform)
└── utils/                 # Utility functions
```

### **Key Files**
- `Canvas.tsx`: High-performance infinite canvas with zoom/pan
- `ComponentModel.ts`: Core component model with responsive styling
- `EditorUIStore.ts`: UI state management and selections
- `ResponsivePageRenderer.tsx`: Renders all canvas elements
- `HudSurface.tsx`: Selection overlays with transform subscription

### **Adding New Features**

#### **New Style Properties**
Add to `ResponsiveStylingPanel.tsx`:
```typescript
<Input 
  type="color"
  value={selectedComponent.getResponsiveStyleValue('borderColor', currentBreakpointId) || '#000000'}
  onChange={(e) => {
    selectedComponent.updateResponsiveStyle('borderColor', e.target.value, currentBreakpointId);
  }}
/>
```

#### **New Component Types**
1. Add to `ComponentsPanel.tsx` library
2. Create helper function in `ComponentModel.ts`
3. Add icon mapping in `LayersPanel.tsx`

## 🎨 Design Philosophy

### **Framer-Inspired Architecture**
- **Unified Canvas Nodes**: Everything on canvas is a node (viewports, floating elements)
- **Ground Wrapper System**: Individual positioning wrappers (not single camera transform)
- **Responsive-First**: Breakpoint awareness built into core component system
- **Professional UX**: Overlay behavior, drag feedback, and selection patterns match industry tools

### **Performance-First**
- **Zero React Re-renders**: Transform operations use direct DOM manipulation
- **Efficient State**: MST provides predictable state with minimal overhead
- **GPU Optimization**: CSS transforms with `will-change` and proper layering
- **Smart Subscriptions**: Only components that need updates subscribe to changes

### **Clean Code Principles**
- **Modular Components**: Each panel is focused and reusable
- **No Prop Drilling**: Direct store access eliminates prop chains
- **Type Safety**: Full TypeScript coverage with proper MST typing
- **Maintainable**: Clear separation between domain logic and UI state

## 🚀 Future Roadmap

### **Advanced Drag & Drop**
- **Drag into Viewports**: Convert floating elements to app tree components
- **Drag out of Viewports**: Convert app components to floating elements
- **Parent Container Highlighting**: Show parent relationships during selection
- **Drop Zone Indicators**: Visual feedback for valid drop targets

### **Enhanced Styling**
- **More CSS Properties**: Padding, margin, typography, shadows
- **Style Presets**: Predefined style combinations
- **Color Palettes**: Project-wide color management
- **Design Tokens**: Consistent design system support

### **Component Library**
- **Custom Components**: User-defined reusable components
- **Component Variants**: Multiple states for buttons, cards, etc.
- **Drag from Library**: Drag components from library to canvas
- **Component Inspector**: Advanced property editing

### **Export & Deploy**
- **Code Export**: Generate clean React components
- **CSS Export**: Responsive CSS with proper breakpoints
- **Design Handoff**: Developer-friendly component specs
- **Live Preview**: Real responsive preview in separate window

## 🤝 Contributing

1. **Fork the repository**
2. **Create feature branch**: `git checkout -b feature/amazing-feature`
3. **Follow code style**: Use existing patterns and TypeScript
4. **Add tests**: Ensure new features are properly tested
5. **Submit PR**: Detailed description of changes

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **Framer**: Inspiration for architecture and UX patterns
- **MobX State Tree**: Powerful state management foundation
- **Next.js Team**: Amazing React framework
- **Radix UI**: Accessible component primitives
- **Tailwind CSS**: Utility-first styling system

---

**Built with ❤️ for designers and developers who appreciate clean architecture and professional UX.**