// Integration control authored by the implementer. Never used as a Blue proposal.
module fifo (
  input logic clk,
  input logic reset,
  input logic write_en,
  input logic read_en,
  input logic [15:0] data_in,
  output logic [15:0] data_out,
  output logic read_valid,
  output logic full,
  output logic empty,
  output logic [5:0] occupancy
);
  logic [15:0] words [0:31];
  logic [4:0] head, tail;
  wire pop = read_en && occupancy != 0;
  wire push = write_en && (occupancy < 32 || pop);
  assign full = occupancy == 32;
  assign empty = occupancy == 0;
  always_ff @(posedge clk) begin
    if (reset) begin
      head <= 0;
      tail <= 0;
      occupancy <= 0;
      data_out <= 0;
      read_valid <= 0;
    end else begin
      read_valid <= pop;
      if (pop) begin
        data_out <= words[head];
        head <= head + 5'd1;
      end
      if (push) begin
        words[tail] <= data_in;
        tail <= tail + 5'd1;
      end
      case ({push, pop})
        2'b10: occupancy <= occupancy + 6'd1;
        2'b01: occupancy <= occupancy - 6'd1;
        default: occupancy <= occupancy;
      endcase
    end
  end
endmodule
