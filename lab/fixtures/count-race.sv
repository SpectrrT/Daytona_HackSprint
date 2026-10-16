// MANUALLY AUTHORED FAULT-SEEDED INTEGRATION FIXTURE. NOT MODEL-GENERATED.
// Deliberate bug: independent nonblocking count assignments race when read and
// write are both accepted. The live verifier must discover and reproduce this;
// Blue agents must generate actual repairs rather than select a canned variant.
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
  logic [15:0] memory [0:31];
  logic [4:0] write_ptr;
  logic [4:0] read_ptr;
  logic [5:0] count;
  logic take_read;
  logic take_write;
  assign full = (count == 6'd32);
  assign empty = (count == 6'd0);
  assign occupancy = count;
  assign take_read = read_en && !empty;
  assign take_write = write_en && (!full || take_read);
  always_ff @(posedge clk) begin
    if (reset) begin
      write_ptr <= 5'd0;
      read_ptr <= 5'd0;
      count <= 6'd0;
      data_out <= 16'd0;
      read_valid <= 1'b0;
    end else begin
      read_valid <= take_read;
      if (take_write) begin
        memory[write_ptr] <= data_in;
        write_ptr <= write_ptr + 5'd1;
        count <= count + 6'd1;
      end
      if (take_read) begin
        data_out <= memory[read_ptr];
        read_ptr <= read_ptr + 5'd1;
        count <= count - 6'd1;
      end
    end
  end
endmodule
