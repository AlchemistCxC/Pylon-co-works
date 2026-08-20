# Process Supervisor examples

`process.json-rpc-echo` is the first Phase 8 process plugin fixture. It demonstrates:

- platform executable selection from `pylon-plugin.json`;
- JSON-RPC 2.0 over newline-delimited stdio;
- typed request/response and `$/cancelRequest`;
- graceful `shutdown` followed by Supervisor timeout escalation;
- process ownership by the activating plugin's `PluginScope`.

The checked-in launchers use Python only to keep the source fixture reviewable. A distributed plugin should package a self-contained executable in the same platform directories.
