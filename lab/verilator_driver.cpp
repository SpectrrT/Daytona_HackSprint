#include "Vfifo.h"
#include "verilated.h"
#include <iostream>
#include <memory>
#include <string>

// Thin observation driver: no oracle or pass/fail logic.
// Protocol: a test begins with T, followed by reset write read data integer lines.
int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  auto dut = std::make_unique<Vfifo>();
  std::string token;
  while (std::cin >> token) {
    if (token == "T") {
      dut = std::make_unique<Vfifo>();
      std::cout << "T\n";
      continue;
    }
    int reset = std::stoi(token), write, read, data;
    if (!(std::cin >> write >> read >> data)) return 2;
    dut->clk = 0;
    dut->reset = reset;
    dut->write_en = write;
    dut->read_en = read;
    dut->data_in = data;
    dut->eval();
    dut->clk = 1;
    dut->eval();
    std::cout << int(dut->read_valid) << ' ' << int(dut->data_out) << ' '
              << int(dut->full) << ' ' << int(dut->empty) << ' '
              << int(dut->occupancy) << '\n';
  }
  dut->final();
  return 0;
}
