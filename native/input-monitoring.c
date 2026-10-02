// Asks macOS about the Input Monitoring permission, which reading a keyboard-like controller needs.
// Run by PTZ Pilot, so macOS counts the question as the app's own: "request" shows the system
// prompt the first time and adds PTZ Pilot to the list in System Settings, which merely failing to
// open the device does not.
//
//   input-monitoring check     prints granted, denied or unknown (never asked)
//   input-monitoring request   asks, then prints the same
#include <IOKit/hidsystem/IOHIDLib.h>
#include <stdio.h>
#include <string.h>

static const char *describe(IOHIDAccessType access) {
	switch (access) {
	case kIOHIDAccessTypeGranted:
		return "granted";
	case kIOHIDAccessTypeDenied:
		return "denied";
	default:
		return "unknown";
	}
}

int main(int argc, char **argv) {
	if (argc != 2 || (strcmp(argv[1], "check") != 0 && strcmp(argv[1], "request") != 0)) {
		fprintf(stderr, "usage: input-monitoring check|request\n");
		return 2;
	}
	if (strcmp(argv[1], "request") == 0) IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
	puts(describe(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)));
	return 0;
}
