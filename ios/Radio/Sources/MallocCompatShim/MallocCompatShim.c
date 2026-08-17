#include "MallocCompatShim.h"

#include <stdlib.h>

void sdallocx(void *ptr, size_t size, int flags) {
    (void)size;
    (void)flags;
    free(ptr);
}
