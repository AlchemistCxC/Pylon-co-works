#include <process.h>
int main(int argc, char **argv) {
    const char *args[256];
    args[0] = "windres";
    int i;
    for (i = 1; i < argc && i < 255; i++) args[i] = argv[i];
    args[i] = 0;
    return _spawnv(_P_WAIT, args[0], args);
}
