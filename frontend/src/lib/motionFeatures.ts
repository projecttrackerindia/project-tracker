// The animation features (springs, gestures, drag, layout and exit animations) for every <m.*> element. LazyMotion in main.tsx loads this
// file after the first screen has painted, so the first visit does not wait for the animation engine; until it arrives elements simply
// show in their resting state.
import { animate, domMax } from 'framer-motion';
export { animate };
export default domMax;
