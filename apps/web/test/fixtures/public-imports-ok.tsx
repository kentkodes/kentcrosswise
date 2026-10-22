// Fixture: a public page that imports only allowed packages.
import { getDemoData } from "@kcw/demo-data";
import { PACKAGE_NAME } from "@kcw/xray";

export default function Ok() {
  return <pre>{String([getDemoData, PACKAGE_NAME])}</pre>;
}
