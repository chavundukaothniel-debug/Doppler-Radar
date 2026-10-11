#pragma once
#include <stdint.h>
constexpr int OUTPUT = 1;
void pinMode(uint8_t, int);
void tone(uint8_t, int);
void noTone(uint8_t);
int digitalRead(uint8_t);
uint32_t micros();
