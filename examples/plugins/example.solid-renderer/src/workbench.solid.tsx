export function ExampleSolidWorkbench(props: { readonly suiteId: string; readonly sheetId: string }) {
  return <div data-example-solid-suite={props.suiteId}>Example Solid Suite · {props.sheetId}</div>
}
