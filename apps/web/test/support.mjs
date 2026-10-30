// Links the workspace's ES modules into one script for the vm-based UI tests.
import {linkSource} from '../../../packages/web-ui/testing/link.mjs';
export const appSource = entry => linkSource(new URL('../src/', import.meta.url), entry);
