// The browser side of the dashboard card's Unpublish proof: the real ProjectCard and its dialog. `refresh`
// does what the server page does: reads the site's state and renders the card again beside the same live
// region (ProjectsHome's `#projects-status`). The bundle's `next/navigation` is a stub with one shared
// router that does nothing, so its `refresh` is given here.

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useRouter } from 'next/navigation';
import ProjectCard, { type ProjectCardProps } from '@/app/projects/ProjectCard';

const w = window as unknown as { __CARD_PROPS__: ProjectCardProps };

function Dashboard() {
  const [props, setProps] = useState(w.__CARD_PROPS__);
  useRouter().refresh = () => {
    void fetch('/card-state')
      .then((res) => res.json())
      .then((next: Partial<ProjectCardProps>) => setProps((current) => ({ ...current, ...next })));
  };
  return (
    <>
      <p id="projects-status" role="status" />
      <ProjectCard {...props} />
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no #root');
createRoot(root).render(<Dashboard />);
// ci-replay touch
