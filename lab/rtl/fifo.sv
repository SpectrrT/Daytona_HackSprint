// Frozen interface: synchronous reset; no empty bypass; full read+write is accepted.
// The controller adds exactly one BUG_* define for a deliberately flawed ancestor.
module fifo (
  input logic clk, input logic reset,
  input logic write_en, input logic read_en,
  input logic [15:0] data_in,
  output logic [15:0] data_out,
  output logic read_valid,
  output logic full, output logic empty,
  output logic [5:0] occupancy
);
  logic [15:0] memory [0:31];
  logic [4:0] write_ptr, read_ptr;
  logic [5:0] count;
  logic take_read, take_write;
  assign full = (count == 6'd32);
  assign empty = (count == 0);
  assign occupancy = count;
`ifdef BUG_EMPTY_BYPASS
  assign take_read = read_en && (!empty || write_en);
`else
  assign take_read = read_en && !empty;
`endif
`ifdef BUG_FULL_DROP
  assign take_write = write_en && !full;
`else
  assign take_write = write_en && (!full || take_read);
`endif
  always_ff @(posedge clk) begin
    if (reset) begin
      write_ptr <= 0;
      read_ptr <= 0;
`ifndef BUG_RESET_LEAK
      count <= 0;
`endif
      data_out <= 0;
      read_valid <= 0;
    end else begin
      read_valid <= take_read;
      if (take_read) begin
        data_out <= memory[read_ptr];
        read_ptr <= read_ptr + 5'd1;
      end
      if (take_write) begin
        memory[write_ptr] <= data_in;
        write_ptr <= write_ptr + 5'd1;
      end
`ifdef BUG_COUNT_RACE
      if (take_write) count <= count + 6'd1;
      if (take_read) count <= count - 6'd1;
`else
      case ({take_write, take_read})
        2'b10: count <= count + 6'd1;
        2'b01: count <= count - 6'd1;
        default: count <= count;
      endcase
`endif
    end
  end
endmodule
